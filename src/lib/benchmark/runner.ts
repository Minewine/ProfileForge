import { createHash } from "node:crypto";
import { BenchmarkFatalError, type BenchmarkConfig } from "@/lib/benchmark/config";
import type { FixtureSet, ManifestCase } from "@/lib/benchmark/fixtures";
import {
  computeExtractionGateOk,
  computeOmissionsReasoned,
  computeOutputLanguageOk,
  computePageBudgetOk,
  computeRequirementCoverage,
  computeSelectionIntegrity,
  computeSummaryLengthOk,
  contentText,
  metric,
  type MetricResult,
} from "@/lib/benchmark/metrics";
import { db } from "@/lib/db";
import type { MatchReport, MatchReportExtras } from "@/lib/jobs/schemas";
import { createAnalysis, getAnalysis, persistReport, storeExtractedRequirements } from "@/lib/jobs/repository";
import { loadPinnedSnapshot } from "@/lib/generation/plan";
import { createGenerationJob } from "@/lib/generation/repository";
import { runGenerationJob } from "@/lib/generation/pipeline";
import {
  GeneratedCVContentSchema,
  SelectionRecordSchema,
  resolveGenerationSettings,
  type GeneratedCVContent,
  type GenerationSettings,
  type SelectionRecord,
} from "@/lib/generation/schemas";
import { callLLM, type CallResult } from "@/lib/llm/router";
import { buildProfileDigest } from "@/lib/matching/digest";
import { deriveKeywords, matchRequirements } from "@/lib/matching/engine";
import { scoreReport } from "@/lib/matching/score";
import { getProfile, importFromDraft } from "@/lib/profile/repository";
import { prepareDraft } from "@/lib/profile/prepareDraft";
import { updateSettings } from "@/lib/settings/store";
import { createRunUser } from "@/lib/benchmark/workspace";
// Task registration side effects (the real router needs the registry; the
// benchmark never registers new tasks).
import "@/lib/llm/tasks/extractrequirements";
import "@/lib/llm/tasks/semanticproposals";

// --- Types (data-model.md §CaseResult) ---

export type BenchmarkStage =
  | "import"
  | "analysis"
  | "extract"
  | "match"
  | "generation_cv"
  | "generation_letter"
  | "measurement";

export type CaseFailure = { stage: BenchmarkStage; cause: string };

export type CaseResult = {
  caseId: string;
  status: "ok" | "failed";
  failure?: CaseFailure;
  metrics: MetricResult[];
  spendUsd: number;
};

export type SetRunOutcome = {
  caseResults: CaseResult[];
  spendUsd: number;
  status: "complete" | "incomplete";
  incompleteReason?: string;
};

type RunState = { runIds: Set<string>; spendUsd: number };

// --- Spend accounting (FR-013) ---

async function trackedLLM(
  state: RunState,
  config: BenchmarkConfig,
  args: Parameters<typeof callLLM>[0],
): Promise<CallResult<unknown>> {
  await enforceCap(state, config);
  if (args.runId) state.runIds.add(args.runId);
  // US4: exact per-task override for the call sites the runner owns.
  const withModel = { ...args, model: args.model ?? config.models[args.task as keyof typeof config.models] };
  const result = await callLLM(withModel);
  state.spendUsd += result.usage.costUsd;
  return result;
}

async function enforceCap(state: RunState, config: BenchmarkConfig): Promise<void> {
  if (state.spendUsd >= config.spendCapUsd) {
    throw new BenchmarkFatalError(
      2,
      `Spend cap of $${config.spendCapUsd.toFixed(2)} reached ($${state.spendUsd.toFixed(4)} spent so far).`,
    );
  }
}

// --- One fixture case, end to end (FR-003: the real pipelines, composed exactly
// as the API routes compose them — never a reimplementation) ---

export async function runBenchmarkCase(args: {
  testCase: ManifestCase;
  fixtureSet: FixtureSet;
  config: BenchmarkConfig;
  state: RunState;
}): Promise<CaseResult> {
  const { testCase, fixtureSet, config, state } = args;
  const profileEntry = fixtureSet.manifest.profiles.find((p) => p.id === testCase.profileId);
  const jdEntry = fixtureSet.manifest.jds.find((j) => j.id === testCase.jdId);
  const profileFixture = fixtureSet.profiles.get(testCase.profileId);
  const jd = fixtureSet.jds.get(testCase.jdId);
  if (!profileEntry || !jdEntry || !profileFixture || !jd) {
    throw new BenchmarkFatalError(3, `Case ${testCase.id}: fixture resolution failed.`);
  }

  let stage: BenchmarkStage = "import";
  try {
    const user = await createRunUser();
    // US4: the run's model mapping drives both tiers of the synthetic user's
    // settings (pipeline-internal calls resolve per tier); the runner's own
    // call sites additionally pass exact per-task overrides below. The
    // pipeline's cost guard shares the benchmark cap (belt and braces).
    const economyModel =
      config.models.extractRequirements ?? config.models.semanticProposals ?? config.models.parseCV;
    const premiumModel = config.models.generateTailoredCV ?? config.models.generateCoverLetter;
    await updateSettings(user.id, {
      costCapUsd: Math.max(config.spendCapUsd, 0.01),
      ...(economyModel ? { modelEconomy: economyModel } : {}),
      ...(premiumModel ? { modelPremium: premiumModel } : {}),
    });

    const doc = await db.sourceDocument.create({
      data: {
        userId: user.id,
        originalFilename: `fixture-${profileEntry.id}.txt`,
        storagePath: `benchmark/${testCase.id}/${profileEntry.id}.txt`,
        sha256: createHash("sha256").update(profileFixture.sourceText).digest("hex"),
        mimeType: "text/plain",
        sizeBytes: Buffer.byteLength(profileFixture.sourceText),
        detectedLanguage: profileFixture.language,
        extractedPages: [{ page: 1, text: profileFixture.sourceText }],
        charCount: profileFixture.sourceText.length,
      },
    });
    const prepared = prepareDraft(profileFixture.draft, doc.id, profileFixture.language, profileFixture.sourceText);
    await importFromDraft(user.id, doc.id, profileFixture.language, prepared.prepared, "replace_parsed");

    stage = "analysis";
    const { analysis } = await createAnalysis(user.id, jd.text);

    stage = "extract";
    const extracted = await trackedLLM(state, config, {
      userId: user.id,
      task: "extractRequirements",
      payload: { text: jd.text, language: analysis.language },
      runId: `bench-${testCase.id}-extract`,
    });
    await storeExtractedRequirements(
      user.id,
      analysis.id,
      (extracted.data as { requirements: Array<{ text: string; category: string; importance: string; isHardConstraint: boolean }> })
        .requirements,
    );

    stage = "match";
    const fresh = await getAnalysis(user.id, analysis.id);
    const profile = await getProfile(user.id);
    const requirements = fresh.requirements.map((r) => ({
      id: r.id,
      text: r.text,
      category: r.category,
      importance: r.importance,
      isHardConstraint: r.isHardConstraint,
      userConfirmed: r.userConfirmed,
    }));
    const pass1 = matchRequirements(requirements, profile, null);
    let proposals: Array<{ requirementIndex: number; entryIds: string[]; rationale?: string }> | null = null;
    let notice: string | null = null;
    if (pass1.unmatchedNonHard.length > 0) {
      const digest = buildProfileDigest(profile);
      if (digest.length > 0) {
        try {
          const result = await trackedLLM(state, config, {
            userId: user.id,
            task: "semanticProposals",
            payload: { language: fresh.language, requirements: pass1.unmatchedNonHard, profileDigest: digest },
            runId: `bench-${testCase.id}-match`,
          });
          proposals = (
            result.data as { proposals: Array<{ requirementIndex: number; entryIds: string[]; rationale?: string }> }
          ).proposals;
        } catch {
          // Same degradation contract as the route: never block, never fabricate.
          notice = "semantic-matching-unavailable";
        }
      }
    }
    const final = matchRequirements(requirements, profile, proposals);
    const { overallScore, scoreBreakdown } = scoreReport(final.matches);
    const keywords = deriveKeywords(final.matches);
    const report = {
      overallScore,
      scoreBreakdown,
      requirements: final.matches,
      recommendedKeywords: keywords.recommended,
      missingKeywords: keywords.missing,
      semanticDropped: final.semanticDropped,
      confirmable: final.confirmable,
    } satisfies MatchReport & MatchReportExtras;
    await persistReport(user.id, analysis.id, profile.version, report, { notice });

    const generate = async (kind: "cv" | "cover_letter"): Promise<{ jobId: string; profileVersion: number; settings: GenerationSettings }> => {
      const settings = resolveGenerationSettings({
        kind,
        analysisLanguage: fresh.language,
        input: { outputLanguage: testCase.outputLanguage },
      });
      const job = await createGenerationJob(user.id, { analysisId: analysis.id, kind, settings });
      await runGenerationJob(job.id);
      const jobRow = await db.generationJob.findUniqueOrThrow({ where: { id: job.id } });
      if (jobRow.runId) state.runIds.add(jobRow.runId);
      await enforceCap(state, config);
      if (jobRow.status !== "succeeded") {
        throw new Error(`generation ${jobRow.status}: ${jobRow.statusError ?? "unknown error"}`);
      }
      return { jobId: job.id, profileVersion: jobRow.profileVersion, settings };
    };

    stage = "generation_cv";
    const cv = await generate("cv");
    const cvVersion = await db.generatedDocumentVersion.findUniqueOrThrow({ where: { producingJobId: cv.jobId } });

    stage = "generation_letter";
    await generate("cover_letter");

    stage = "measurement";
    const content: GeneratedCVContent = GeneratedCVContentSchema.parse(cvVersion.content);
    const selection: SelectionRecord | null =
      cvVersion.selection == null ? null : SelectionRecordSchema.parse(cvVersion.selection);
    const extractionCheck = cvVersion.extractionCheck as { passed?: boolean; pages?: number } | null;
    const snapshot = await loadPinnedSnapshot(user.id, cv.profileVersion);

    const coverage = computeRequirementCoverage(report, content);
    const metrics: MetricResult[] = [
      metric("requirement_coverage", coverage.rate, "model_dependent"),
      metric("selection_integrity", computeSelectionIntegrity(content, selection, snapshot), "deterministic"),
      metric("omissions_reasoned", computeOmissionsReasoned(content), "deterministic"),
      metric("summary_length_ok", computeSummaryLengthOk(content, cv.settings), "deterministic"),
      metric("page_budget_ok", computePageBudgetOk(extractionCheck, cv.settings), "deterministic"),
      metric("output_language_ok", computeOutputLanguageOk(contentText(content), testCase.outputLanguage), "deterministic"),
      metric("extraction_gate_ok", computeExtractionGateOk(extractionCheck), "deterministic"),
    ];

    return {
      caseId: testCase.id,
      status: "ok",
      metrics,
      spendUsd: state.spendUsd,
    };
  } catch (err) {
    if (err instanceof BenchmarkFatalError) throw err;
    const cause = err instanceof Error ? err.message : String(err);
    return {
      caseId: testCase.id,
      status: "failed",
      failure: { stage, cause },
      metrics: [],
      spendUsd: state.spendUsd,
    };
  }
}

// --- The whole fixture set ---

export async function runBenchmarkSet(args: {
  config: BenchmarkConfig;
  fixtureSet: FixtureSet;
}): Promise<SetRunOutcome> {
  const { config, fixtureSet } = args;
  const state: RunState = { runIds: new Set(), spendUsd: 0 };
  const selected = config.caseIds
    ? fixtureSet.manifest.cases.filter((c) => config.caseIds!.includes(c.id))
    : fixtureSet.manifest.cases;
  const results: CaseResult[] = [];
  let incompleteReason: string | undefined;

  for (const testCase of selected) {
    try {
      results.push(await runBenchmarkCase({ testCase, fixtureSet, config, state }));
    } catch (err) {
      if (err instanceof BenchmarkFatalError && err.exitCode === 2) {
        incompleteReason = err.message;
      } else {
        incompleteReason = `unexpected runner failure: ${err instanceof Error ? err.message : String(err)}`;
      }
      break;
    }
  }

  // SC-002: every selected case is recorded — failures and not-run cases are
  // recorded as failures, never silently missing.
  const recorded = new Set(results.map((r) => r.caseId));
  for (const testCase of selected) {
    if (!recorded.has(testCase.id)) {
      results.push({
        caseId: testCase.id,
        status: "failed",
        failure: {
          stage: "measurement",
          cause: incompleteReason ? `not run — ${incompleteReason}` : "not run",
        },
        metrics: [],
        spendUsd: state.spendUsd,
      });
    }
  }

  const status = !incompleteReason && results.every((r) => r.status === "ok") ? "complete" : "incomplete";
  return { caseResults: results, spendUsd: state.spendUsd, status, incompleteReason };
}
