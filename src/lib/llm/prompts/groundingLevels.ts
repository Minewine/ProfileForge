import type { GroundingLevel } from "@/lib/generation/schemas";

/**
 * Per-level embellishment directives for the drafting tasks, assembled in code
 * (dynamic content never goes into the static .md system prompts, whose content
 * hash pins the benchmark prompt set version — see load.ts). "strict" is today's
 * behavior and adds NO directive: strict task payloads and prompts stay
 * byte-identical, so pinned benchmark transcripts keep replaying.
 *
 * The deterministic layer is mode-independent: checkGrounding
 * (src/lib/generation/grounding.ts) keeps flagging invented numbers/acronyms as
 * GROUNDING_FAILED warnings at every level — numbers, dates, employers,
 * technologies stay profile-locked in all modes.
 *
 * The client-facing one-liners for the generation panel live in
 * GROUNDING_LEVEL_EXPLANATIONS (src/lib/client-messages.ts) — keep the two
 * wordings in sync when editing either side.
 */
export const GROUNDING_LEVEL_DIRECTIVES: Record<Exclude<GroundingLevel, "strict">, string> = {
  polished:
    "rewrite with stronger verbs and confident framing of the existing content; every fact still comes " +
    "only from the plan and its source texts, numbers, dates, employer/institution names, and technologies " +
    "are copied exactly, and you add no achievements, skills, tools, or metrics that are not already there",
  embellished:
    "everything the polished level allows, plus plausible qualitative elaboration around the real experience " +
    "(ownership, collaboration, outcome framing) as long as it stays consistent with the source evidence; " +
    "still never invent employers, job titles, dates, degrees, credentials, technologies, numbers, or metrics, " +
    "and never introduce new named entities",
};
