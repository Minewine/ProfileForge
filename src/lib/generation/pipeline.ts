import { db } from "@/lib/db";
import { ApiError, redact } from "@/lib/api/errors";
import {
  ensureDocument,
  markCancelled,
  markFailed,
  markRunning,
  markSucceeded,
  registerActiveJob,
  setVersionArtifacts,
  unregisterActiveJob,
  upsertJobVersion,
} from "@/lib/generation/repository";
import {
  GenerationSettingsSchema,
  type ArtifactMeta,
  type CoverLetterContent,
  type GeneratedCVContent,
  type GenerationKind,
  type GenerationSettings,
  type SelectionRecord,
  type ValidationFlag,
  type ValidationReport,
} from "@/lib/generation/schemas";
import type { MatchReport } from "@/lib/jobs/schemas";
import {
  runPlanStage,
  runPreconditionsStage,
  type CVPlan,
  type LetterPlan,
  type PinnedSnapshot,
} from "@/lib/generation/plan";
import { draftCV, draftLetter } from "@/lib/generation/draft";
import { fitCVToBudget, fitLetterToBudget } from "@/lib/generation/fit";
import { renderCVForSettings } from "@/lib/generation/render/dispatch";
import { letterPlainText, renderLetter } from "@/lib/generation/render/letter";
import { renderCVDocx } from "@/lib/generation/render/docx";
import { sanitizeToAscii } from "@/lib/generation/render/template";
import { EXPORT_GATE_MAX_ATTEMPTS, runExtractionGate, type ExtractionCheck } from "@/lib/generation/verify";
import { writeGenerationArtifacts } from "@/lib/generation/artifacts";

/**
 * Async generation-job runner (research R4): DB-backed status, in-process
 * execution, client polling. Routes call `kickoffGenerationJob` and return 202
 * immediately; `runGenerationJob` drives `queued → running → succeeded|failed|
 * cancelled`, checking `cancelRequested` at every stage boundary.
 */

export type StageName = "preconditions" | "plan" | "draft" | "render" | "gate" | "persist";

export type StageContext = {
  jobId: string;
  analysisId: string;
  /** One runId per attempt — the cost-cap scope wired into every callLLM call. */
  runId: string;
  kind: GenerationKind;
  settings: GenerationSettings;
  /** Pinned at creation; content is read from this snapshot only (research R5). */
  profileVersion: number;
  /** Owner of the job's analysis — every profile/settings read inside the run is scoped to them. */
  userId: string;
  notice: string | null;
  // Stage outputs (contracts/generation-pipeline.md stages 1–7).
  pinnedSnapshot: PinnedSnapshot | null; // [1]
  matchReport: MatchReport | null; // [1] evidence resolved against the pinned snapshot
  plan: CVPlan | LetterPlan | null; // [2] discriminated by `kind`
  /** [2] SelectionRecord built by the plan stage (feature 005) — null until US1
   *  lands the real builder; persisted with the version. */
  selection: SelectionRecord | null;
  content: GeneratedCVContent | CoverLetterContent | null; // [3+5] fitted after render — omissions final
  /** [2, letters only] current CV bullet/summary texts — the anti-repetition
   *  input for the draft prompt (R11). */
  letterCvTexts: string[];
  warnings: ValidationFlag[]; // [3] draft warnings feeding the validation report
  validationReport: ValidationReport | null; // [4]
  pdfBytes: Uint8Array | null; // [5] the fitted (or gate-retry) render
  artifacts: ArtifactMeta[] | null; // [7]
  extractionCheck: ExtractionCheck | null; // [6]
};

export type Stage = {
  name: StageName;
  run: (ctx: StageContext) => Promise<void>;
};

/** Raised internally when `cancelRequested` is observed at a stage boundary. */
export class GenerationCancelled extends Error {
  constructor() {
    super("Generation job cancellation requested.");
    this.name = "GenerationCancelled";
  }
}

/** Cancel check used between stages — and before each LLM call in later slices. */
export async function assertNotCancelled(jobId: string): Promise<void> {
  const row = await db.generationJob.findUnique({
    where: { id: jobId },
    select: { cancelRequested: true },
  });
  if (row?.cancelRequested) throw new GenerationCancelled();
}

function describeStageError(stage: StageName | "pipeline", err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`;
  return `INTERNAL_ERROR: stage "${stage}" failed: ${
    redact(err instanceof Error ? err.message : String(err))
  }`;
}

/** Stages per contracts/generation-pipeline.md: preconditions → plan → draft →
 *  render+fit → extraction gate → artifacts & persist. The Fact Guard stage was
 *  removed — tailoring now happens entirely in the draft prompt, and the only
 *  remaining checks are the deterministic fit loop and extraction gate. */
export function buildStages(): Stage[] {
  return [
    // [1] pin snapshot, resolve MatchReport evidence refs (dangling → skip + notice)
    { name: "preconditions", run: runPreconditionsStage },
    // [2] deterministic ranking + skills list + must-include set
    { name: "plan", run: runPlanStage },
    // [3] premium LLM keyed rephrase/translate + keyed merge (R7; letters: R11).
    // Draft warnings (VERBATIM_FALLBACK / UNCERTAIN_TRANSLATION) become a
    // warnings-only validation report — informational, never gating.
    {
      name: "draft",
      run: async (ctx: StageContext): Promise<void> => {
        if (!ctx.plan) throw new Error("Draft stage requires the plan stage output.");
        const plan = ctx.plan;
        const checkCancelled = () => assertNotCancelled(ctx.jobId); // before every LLM call
        const { content, warnings } =
          plan.kind === "letter"
            ? await draftLetter({
                userId: ctx.userId,
                plan,
                settings: ctx.settings,
                cvTexts: ctx.letterCvTexts,
                runId: ctx.runId,
                checkCancelled,
              })
            : await draftCV({
                userId: ctx.userId,
                plan,
                settings: ctx.settings,
                runId: ctx.runId,
                checkCancelled,
              });
        ctx.content = content;
        ctx.warnings = warnings;
        ctx.validationReport = {
          flags: warnings,
          summary: { blockers: 0, warnings: warnings.length },
        };
      },
    },
    // [4] render & fit: measure-and-demote loop → omissions final on content
    {
      name: "render",
      run: async (ctx: StageContext): Promise<void> => {
        if (!ctx.content || !ctx.plan || !ctx.pinnedSnapshot) {
          throw new Error("Render stage requires the plan, draft, and preconditions outputs.");
        }
        const content = ctx.content;
        if ("paragraphs" in content) {
          const fitted = await fitLetterToBudget({
            content,
            plan: ctx.plan as LetterPlan, // plan and content kinds always match (stages 2–3)
            snapshot: ctx.pinnedSnapshot,
            settings: ctx.settings,
          });
          ctx.content = fitted.content;
          ctx.pdfBytes = fitted.bytes;
          return;
        }
        const fitted = await fitCVToBudget({
          content,
          plan: ctx.plan as CVPlan,
          snapshot: ctx.pinnedSnapshot,
          settings: ctx.settings,
        });
        ctx.content = fitted.content; // THIS is the content the version persists
        ctx.pdfBytes = fitted.bytes;
      },
    },
    // [5] extraction gate: two-level check on the rendered bytes with bounded
    // re-render retries (deterministic renderer + ASCII-sanitization fallback
    // pass). Still failing ⇒ job fails EXPORT_GATE_FAILED and the full check
    // results are stored on a gate-failed version with NO artifacts (SC-003).
    {
      name: "gate",
      run: async (ctx: StageContext): Promise<void> => {
        if (!ctx.content || !ctx.pinnedSnapshot || !ctx.pdfBytes || !ctx.validationReport) {
          throw new Error("Gate stage requires the render and validation outputs.");
        }
        let bytes = ctx.pdfBytes;
        let check = await runExtractionGate({
          pdfBytes: bytes,
          content: ctx.content,
          snapshot: ctx.pinnedSnapshot,
          settings: ctx.settings,
        });
        for (let attempt = 2; !check.passed && attempt <= EXPORT_GATE_MAX_ATTEMPTS; attempt++) {
          const renderArgs = {
            snapshot: ctx.pinnedSnapshot,
            settings: ctx.settings,
            sanitize: sanitizeToAscii, // fallback pass (FR-013 re-render attempt)
          };
          bytes = (
            "paragraphs" in ctx.content
              ? await renderLetter({ ...renderArgs, content: ctx.content })
              : await renderCVForSettings({ ...renderArgs, content: ctx.content })
          ).bytes;
          check = await runExtractionGate({
            pdfBytes: bytes,
            content: ctx.content,
            snapshot: ctx.pinnedSnapshot,
            settings: ctx.settings,
          });
        }
        ctx.pdfBytes = bytes;
        ctx.extractionCheck = check;
        if (!check.passed) {
          // Store the failing results where the UI and the download error path
          // read them (version.extractionCheck) — never any artifact file.
          // `upsertJobVersion`: a retry of this job refreshes this row in place,
          // so selection is passed explicitly (even null) — absent would wipe it.
          const document = await ensureDocument(ctx.analysisId, ctx.kind);
          await upsertJobVersion({
            documentId: document.id,
            producingJobId: ctx.jobId,
            content: ctx.content,
            validationReport: ctx.validationReport,
            extractionCheck: check,
            selection: ctx.selection,
          });
          throw new ApiError(
            "EXPORT_GATE_FAILED",
            `The rendered PDF failed the extraction gate after ${EXPORT_GATE_MAX_ATTEMPTS} attempts — no artifact was written.`,
            { extractionCheck: check },
          );
        }
      },
    },
    // [6] artifacts & persist: append the version first (its id drives the
    // artifact path), then write pdf (gate passed) + docx (best-effort) and
    // store the metadata + check result onto that version.
    {
      name: "persist",
      run: async (ctx: StageContext): Promise<void> => {
        if (!ctx.content || !ctx.validationReport || !ctx.pdfBytes || !ctx.pinnedSnapshot || !ctx.extractionCheck) {
          throw new Error("Persist stage requires the draft, validation, render, and gate outputs.");
        }
        const document = await ensureDocument(ctx.analysisId, ctx.kind);
        const version = await upsertJobVersion({
          documentId: document.id,
          producingJobId: ctx.jobId,
          content: ctx.content,
          validationReport: ctx.validationReport,
          selection: ctx.selection, // the plan stage's SelectionRecord (feature 005; null for letters)
        });
        // CV: best-effort DOCX alongside the verified PDF. Letter: copyable
        // plain text instead (FR-017); no DOCX for letters in this slice.
        // Both extras are non-fatal (FR-014: best-effort — a DOCX failure must
        // never discard the gate-verified PDF; P1 review finding).
        let docx: Uint8Array | undefined;
        if (!("paragraphs" in ctx.content)) {
          try {
            docx = await renderCVDocx({
              content: ctx.content,
              snapshot: ctx.pinnedSnapshot,
              settings: ctx.settings,
            });
          } catch (err) {
            console.warn(redact(`docx render failed for job ${ctx.jobId} (pdf still delivered): ${String(err)}`));
          }
        }
        const txt = "paragraphs" in ctx.content ? letterPlainText(ctx.content) : undefined;
        const artifacts = await writeGenerationArtifacts({
          versionId: version.id,
          kind: ctx.kind,
          pdf: ctx.pdfBytes,
          ...(docx !== undefined ? { docx } : {}),
          ...(txt !== undefined ? { txt } : {}),
        });
        await setVersionArtifacts(version.id, { artifacts, extractionCheck: ctx.extractionCheck });
        ctx.artifacts = artifacts;
      },
    },
  ];
}

export async function runGenerationJob(jobId: string, stages: Stage[] = buildStages()): Promise<void> {
  const job = await db.generationJob.findUnique({
    where: { id: jobId },
    include: { analysis: { select: { userId: true } } },
  });
  // Quarantine: a legacy analysis with no owner can never reach a scoped
  // creation path, so a null userId here means the job must not run (FR-009).
  if (!job || job.status !== "queued" || job.analysis.userId === null) return; // unknown, terminal, quarantined, or already running elsewhere

  registerActiveJob(jobId); // excluded from stale-running recovery while we own it
  try {
    const running = await markRunning(jobId, job.runId ?? undefined);
    const ctx: StageContext = {
      jobId,
      analysisId: job.analysisId,
      runId: running.runId!,
      kind: job.kind as GenerationKind,
      settings: GenerationSettingsSchema.parse(job.settings),
      profileVersion: job.profileVersion,
      userId: job.analysis.userId,
      notice: job.notice,
      pinnedSnapshot: null,
      matchReport: null,
      plan: null,
      selection: null,
      content: null,
      letterCvTexts: [],
      warnings: [],
      validationReport: null,
      pdfBytes: null,
      artifacts: null,
      extractionCheck: null,
    };
    for (const stage of stages) {
      await assertNotCancelled(jobId); // between stages
      try {
        await stage.run(ctx);
      } catch (err) {
        if (err instanceof GenerationCancelled) throw err; // cancel wins over failure
        await markFailed(jobId, describeStageError(stage.name, err));
        return;
      }
    }
    await assertNotCancelled(jobId); // a cancel landing during the last stage still wins
    await markSucceeded(jobId);
  } catch (err) {
    if (err instanceof GenerationCancelled) {
      await markCancelled(jobId).catch(() => {});
      return;
    }
    // Transition-level failure (e.g. the row changed under us): record it if we still can.
    await markFailed(jobId, describeStageError("pipeline", err)).catch(() => {});
  } finally {
    unregisterActiveJob(jobId);
  }
}

// Kickoff dedupe must be process-wide: Next.js bundles each route separately,
// so a module-scoped map would let two copies of this module start the same
// job (globalThis pattern as db.ts / activeJobs).
const globalForInFlight = globalThis as unknown as { generationInFlight?: Map<string, Promise<void>> };
const inFlight: Map<string, Promise<void>> = (globalForInFlight.generationInFlight ??= new Map());

/** Route entry point: start the run without awaiting it (R4). Never throws. */
export function kickoffGenerationJob(jobId: string): void {
  if (inFlight.has(jobId)) return;
  const run = runGenerationJob(jobId).catch((err) => {
    console.error(redact(`generation job ${jobId} crashed: ${String(err)}`));
  });
  inFlight.set(jobId, run);
  void run.finally(() => {
    inFlight.delete(jobId);
  });
}

/** Resolve when a kicked-off run for this job has settled (test/helper hook). */
export async function waitForJobSettled(jobId: string): Promise<void> {
  const run = inFlight.get(jobId);
  if (run) await run;
}
