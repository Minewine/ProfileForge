import { extractPdfPages } from "@/lib/parsing/pdf";
import { checkContainment } from "@/lib/validation/sourceContainment";
import { normalizeText } from "@/lib/text/normalize";
import type { PinnedSnapshot } from "@/lib/generation/plan";
import type {
  CoverLetterContent,
  GeneratedCVContent,
  GenerationSettings,
} from "@/lib/generation/schemas";
import { activeSections, cvBasics } from "@/lib/generation/render/cv";
import { sectionHeading } from "@/lib/generation/render/template";

/**
 * Stage 6 — the two-level extraction gate (FR-013, research R2) applied to the
 * rendered PDF bytes: level 1 structural presence (100% required) and level 2
 * per-block ≥95% word recovery via the existing `checkContainment` — the same
 * case/accent/punctuation-insensitive normalization for FR and EN, so
 * legitimate French accents never fail the gate.
 */

export const EXTRACTION_THRESHOLD = 0.95; // checkContainment's own threshold, restated for the report
/** Bounded re-render attempts (initial render + 2 fallback-sanitized passes). */
export const EXPORT_GATE_MAX_ATTEMPTS = 3;

// --- Result shape (persisted as the version's `extractionCheck` JSONB) ---

export type ExtractionElementResult = {
  element: string; // e.g. "name", "contact:email", "heading:experience", "experience:e1:company"
  expected: string;
  found: boolean;
};

export type ExtractionBlockResult = {
  claimId: string; // block identity ("summary", "exp.e1.2", "skill:Kubernetes", "letter.1", …)
  kind:
    | "summary"
    | "experience_bullet"
    | "project_bullet"
    | "education"
    | "certification"
    | "skill"
    | "letter_paragraph"; // US6
  ratio: number;
  ok: boolean;
};

export type ExtractionCheck = {
  passed: boolean;
  pages: number;
  level1: { passed: boolean; elements: ExtractionElementResult[] };
  level2: { passed: boolean; threshold: number; blocks: ExtractionBlockResult[] };
};

// --- Level 1: structural elements (normalized-substring presence) ---

function structuralElements(
  content: GeneratedCVContent | CoverLetterContent,
  snapshot: PinnedSnapshot,
  settings: GenerationSettings,
): Array<{ element: string; expected: string }> {
  const elements: Array<{ element: string; expected: string }> = [];
  const push = (element: string, expected: string | null | undefined) => {
    const value = expected?.trim();
    if (value) elements.push({ element, expected: value }); // empty items render nothing → nothing to check
  };

  const basics = cvBasics(snapshot);
  push("name", basics.name);
  for (const item of basics.contact) {
    push(`contact:${item.label}`, item.value); // email, phone, link:0, …
  }
  // Letters have no section headings or entry headers (US6): name + contact are
  // their whole structural level; paragraphs are covered at level 2.
  if ("paragraphs" in content) return elements;
  for (const section of activeSections(content)) {
    push(`heading:${section}`, sectionHeading(settings.outputLanguage, section));
  }
  for (const entry of content.experience) {
    if (entry.bullets.length === 0) continue;
    const meta = snapshot.experience.find((e) => e.id === entry.id);
    if (!meta) continue; // unresolvable meta renders no heading — nothing to check
    push(`experience:${entry.id}:company`, meta.company);
    // feature 005 US2: the rendered heading carries the REWRITTEN title when
    // the content carries one (fallback: the snapshot title)
    push(`experience:${entry.id}:title`, entry.title?.text?.trim() || meta.title);
    const start = meta.startDate?.trim();
    const end = meta.endDate?.trim() || (start ? "present" : "");
    push(`experience:${entry.id}:startDate`, start);
    push(`experience:${entry.id}:endDate`, end);
  }
  return elements;
}

// --- Level 2: rendered content blocks ---

function contentBlocks(
  content: GeneratedCVContent | CoverLetterContent,
): Array<{ claimId: string; kind: ExtractionBlockResult["kind"]; text: string }> {
  const blocks: Array<{ claimId: string; kind: ExtractionBlockResult["kind"]; text: string }> = [];
  if ("paragraphs" in content) {
    for (const paragraph of content.paragraphs) {
      if (paragraph.text.trim()) blocks.push({ claimId: paragraph.claimId, kind: "letter_paragraph", text: paragraph.text });
    }
    return blocks;
  }
  if (content.summary.trim()) blocks.push({ claimId: "summary", kind: "summary", text: content.summary });
  for (const entry of content.experience) {
    for (const bullet of entry.bullets) {
      blocks.push({ claimId: bullet.claimId, kind: "experience_bullet", text: bullet.text });
    }
  }
  for (const project of content.projects) {
    for (const bullet of project.bullets) {
      blocks.push({ claimId: bullet.claimId, kind: "project_bullet", text: bullet.text });
    }
  }
  for (const education of content.education) {
    blocks.push({ claimId: education.claimId, kind: "education", text: education.text });
  }
  for (const certification of content.certifications) {
    blocks.push({ claimId: certification.claimId, kind: "certification", text: certification.text });
  }
  for (const skill of content.skills) {
    if (skill.trim()) blocks.push({ claimId: `skill:${skill}`, kind: "skill", text: skill });
  }
  return blocks;
}

function failedCheck(
  elements: Array<{ element: string; expected: string }>,
  blocks: ReturnType<typeof contentBlocks>,
): ExtractionCheck {
  return {
    passed: false,
    pages: 0,
    level1: { passed: false, elements: elements.map((e) => ({ ...e, found: false })) },
    level2: {
      passed: false,
      threshold: EXTRACTION_THRESHOLD,
      blocks: blocks.map((b) => ({ claimId: b.claimId, kind: b.kind, ratio: 0, ok: false })),
    },
  };
}

/** Run the two-level gate on the rendered bytes. Never throws for bad input —
 *  an unreadable render is a failed check (the pipeline retries, then fails
 *  the job with `EXPORT_GATE_FAILED`). */
export async function runExtractionGate(args: {
  pdfBytes: Uint8Array;
  content: GeneratedCVContent | CoverLetterContent;
  snapshot: PinnedSnapshot;
  settings: GenerationSettings;
}): Promise<ExtractionCheck> {
  const elements = structuralElements(args.content, args.snapshot, args.settings);
  const blocks = contentBlocks(args.content);

  let extracted: string;
  let pages: number;
  try {
    // unpdf transfers (detaches) the buffer it extracts — always hand it a
    // copy so the caller's bytes stay writable to disk afterwards.
    const pageTexts = await extractPdfPages(new Uint8Array(args.pdfBytes));
    pages = pageTexts.length;
    extracted = pageTexts.map((p) => p.text).join("\n");
  } catch {
    return failedCheck(elements, blocks); // garbled/unreadable render ⇒ fails both levels
  }

  const haystack = normalizeText(extracted);
  const found = (expected: string): boolean => {
    const needle = normalizeText(expected);
    return needle === "" ? true : haystack.includes(needle);
  };

  const level1Elements = elements.map((e) => ({ ...e, found: found(e.expected) }));
  const level1Passed = level1Elements.every((e) => e.found);

  const level2Blocks = blocks.map((block) => {
    const { ratio, ok } = checkContainment(block.text, extracted);
    return { claimId: block.claimId, kind: block.kind, ratio, ok };
  });
  const level2Passed = level2Blocks.every((b) => b.ok);

  return {
    passed: level1Passed && level2Passed,
    pages,
    level1: { passed: level1Passed, elements: level1Elements },
    level2: { passed: level2Passed, threshold: EXTRACTION_THRESHOLD, blocks: level2Blocks },
  };
}
