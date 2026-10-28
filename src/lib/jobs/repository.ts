import { db } from "@/lib/db";
import { ApiError } from "@/lib/api/errors";
import { detectLanguage } from "@/lib/parsing/language";
import type { AnalysisStatus, MatchReport } from "@/lib/jobs/schemas";
import { MAX_JD_CHARS, MIN_JD_CHARS } from "@/lib/jobs/schemas";
import type { LanguageCode } from "@/lib/validation/schemas";

type RequirementRow = {
  id: string;
  text: string;
  category: string;
  importance: string;
  isHardConstraint: boolean;
  order: number;
  source: string;
  userConfirmed: boolean;
};

type AnalysisWithRequirements = {
  id: string;
  jdText: string;
  language: string;
  languageManuallyCorrected: boolean;
  status: string;
  statusError: string | null;
  jdRole: string | null; // extraction output — draft-prompt input (null = absent in the JD)
  jdCompany: string | null;
  profileVersion: number | null;
  matchReport: unknown;
  semanticDropped: number;
  notice: string | null;
  rerunOfId: string | null;
  createdAt: Date;
  updatedAt: Date;
  requirements: RequirementRow[];
};

const includeRequirements = { requirements: { orderBy: { order: "asc" as const } } };

function assertStatus(analysis: { status: string }, allowed: AnalysisStatus[], action: string) {
  if (!allowed.includes(analysis.status as AnalysisStatus)) {
    throw new ApiError(
      "INVALID_STATE",
      `Cannot ${action} while the analysis is "${analysis.status}" (allowed: ${allowed.join(", ")}).`,
      { status: analysis.status },
    );
  }
}

// --- Create & list ---

export async function createAnalysis(userId: string, text: string) {
  const trimmed = text.trim();
  if (trimmed.length < MIN_JD_CHARS) {
    throw new ApiError(
      "JD_TOO_SHORT",
      `The job description is too short to analyze (${trimmed.length} chars; minimum ${MIN_JD_CHARS}). Paste the full text.`,
    );
  }
  if (trimmed.length > MAX_JD_CHARS) {
    throw new ApiError(
      "JD_TOO_LONG",
      `The job description exceeds the ${MAX_JD_CHARS.toLocaleString()}-character limit. Split it or shorten it — it is never truncated silently.`,
    );
  }
  const detection = detectLanguage(trimmed);
  const analysis = await db.jobAnalysis.create({
    data: { jdText: trimmed, language: detection.language, userId },
    include: includeRequirements,
  });
  return { analysis, languageLowConfidence: !detection.confident };
}

export async function listAnalyses(userId: string) {
  const rows = await db.jobAnalysis.findMany({
    where: { userId },
    orderBy: { updatedAt: "desc" },
    include: { requirements: { select: { id: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    language: r.language,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    requirementCount: r.requirements.length,
    rerunOfId: r.rerunOfId,
    title: r.jdText.slice(0, 60).replace(/\s+/g, " "),
    overallScore:
      (r.matchReport as MatchReport | null)?.overallScore ?? null,
  }));
}

export async function getAnalysis(userId: string, id: string): Promise<AnalysisWithRequirements> {
  const analysis = await db.jobAnalysis.findFirst({
    where: { id, userId },
    include: includeRequirements,
  });
  if (!analysis) throw new ApiError("NOT_FOUND", "Analysis not found.");
  return analysis as AnalysisWithRequirements;
}

export async function updateLanguage(userId: string, id: string, language: LanguageCode) {
  const analysis = await getAnalysis(userId, id);
  assertStatus(analysis, ["created", "extracted", "finalized", "failed"], "correct the language of");
  const updated = await db.jobAnalysis.update({
    where: { id },
    data: { language, languageManuallyCorrected: true },
  });
  return { id: updated.id, language: updated.language };
}

export async function deleteAnalysis(userId: string, id: string) {
  const analysis = await db.jobAnalysis.findFirst({ where: { id, userId } });
  if (!analysis) throw new ApiError("NOT_FOUND", "Analysis not found.");
  await db.jobAnalysis.delete({ where: { id } });
}

// --- Extraction & requirements ---

export async function storeExtractedRequirements(
  userId: string,
  id: string,
  extracted: Array<{ text: string; category: string; importance: string; isHardConstraint: boolean }>,
  extras: { role?: string | null; company?: string | null } = {},
) {
  const analysis = await getAnalysis(userId, id);
  assertStatus(analysis, ["created", "extracted", "failed"], "extract requirements for");
  const replaced = analysis.requirements.length > 0;

  await db.$transaction(async (tx) => {
    await tx.jobRequirement.deleteMany({ where: { analysisId: id } });
    for (const [order, r] of extracted.entries()) {
      await tx.jobRequirement.create({
        data: { analysisId: id, ...r, order, source: "extracted" },
      });
    }
    await tx.jobAnalysis.update({
      where: { id },
      data: {
        status: "extracted",
        statusError: null,
        // the draft prompts address the actual role/company (null = absent in the JD)
        ...(extras.role !== undefined ? { jdRole: extras.role } : {}),
        ...(extras.company !== undefined ? { jdCompany: extras.company } : {}),
      },
    });
  });
  return { replacedRequirements: replaced, requirements: await getAnalysis(userId, id).then((a) => a.requirements) };
}

export async function markExtractFailed(userId: string, id: string, message: string) {
  await getAnalysis(userId, id); // NOT_FOUND guard
  await db.jobAnalysis.update({ where: { id }, data: { status: "failed", statusError: message } });
}

export type RequirementInputRow = {
  text: string;
  category: string;
  importance: string;
  isHardConstraint: boolean;
};

export async function replaceRequirements(userId: string, id: string, rows: RequirementInputRow[], finalize: boolean) {
  const analysis = await getAnalysis(userId, id);
  assertStatus(analysis, ["extracted", "finalized"], "replace requirements for");

  // Preserve user confirmations across full-list replaces (matched by text+category).
  const confirmations = new Map(
    analysis.requirements
      .filter((r) => r.userConfirmed)
      .map((r) => [`${r.text}::${r.category}`, true]),
  );

  await db.$transaction(async (tx) => {
    await tx.jobRequirement.deleteMany({ where: { analysisId: id } });
    for (const [order, r] of rows.entries()) {
      await tx.jobRequirement.create({
        data: {
          analysisId: id,
          text: r.text,
          category: r.category,
          importance: r.importance,
          isHardConstraint: r.isHardConstraint,
          order,
          source: "user",
          userConfirmed: confirmations.get(`${r.text}::${r.category}`) ?? false,
        },
      });
    }
    const status = finalize ? "finalized" : analysis.status === "finalized" ? "finalized" : "extracted";
    await tx.jobAnalysis.update({ where: { id }, data: { status } });
  });

  const updated = await getAnalysis(userId, id);
  return { status: updated.status, requirements: updated.requirements };
}

// --- Matching ---

export async function persistReport(
  userId: string,
  id: string,
  profileVersion: number,
  report: MatchReport,
  options: { recompute?: boolean; notice?: string | null } = {},
) {
  const analysis = await getAnalysis(userId, id);
  if (analysis.matchReport != null && !options.recompute) {
    throw new ApiError(
      "INVALID_STATE",
      "This analysis already has a stored report. Use recompute or a re-run instead — stored reports never change silently.",
    );
  }
  const updated = await db.jobAnalysis.update({
    where: { id },
    data: {
      status: "matched",
      statusError: null,
      profileVersion,
      matchReport: report as unknown as object,
      semanticDropped: report.semanticDropped,
      notice: options.notice ?? null,
    },
  });
  return updated;
}

export async function rerunAnalysis(userId: string, id: string) {
  const source = await getAnalysis(userId, id);
  assertStatus(source, ["matched"], "re-run");

  const created = await db.$transaction(async (tx) => {
    const analysis = await tx.jobAnalysis.create({
      data: {
        jdText: source.jdText,
        language: source.language,
        languageManuallyCorrected: source.languageManuallyCorrected,
        status: "finalized",
        rerunOfId: source.id,
        userId,
      },
    });
    for (const r of source.requirements) {
      await tx.jobRequirement.create({
        data: {
          analysisId: analysis.id,
          text: r.text,
          category: r.category,
          importance: r.importance,
          isHardConstraint: r.isHardConstraint,
          order: r.order,
          source: r.source,
          userConfirmed: r.userConfirmed,
        },
      });
    }
    return analysis;
  });
  return created.id;
}
