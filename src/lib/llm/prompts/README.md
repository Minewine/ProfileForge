# System prompts

The five LLM task system prompts live here as version-controlled Markdown files,
one per task (`parsecv.ts` → `parseCV.md`, etc.). Task modules load theirs at
import time via `load.ts` (`loadSystemPrompt`), so a missing or empty file fails
task registration — and therefore startup — loudly.

Rules for editing these files:

- **Zero-invention rules are non-negotiable.** Every prompt contains the
  "Rules (non-negotiable)" block that forbids inventing facts, IDs, dates, or
  metrics and mandates JSON-only responses. Any edit must preserve that
  contract; the surrounding Zod schemas and key-echoing logic enforce it in
  code, but the prompt is the first line of defense.
- **Only `{summaryMaxWords}` is a placeholder** (in `generateTailoredCV.md`).
  It is substituted per request in `src/lib/llm/tasks/generatetailoredcv.ts` —
  plain string replacement, no template engine. Do not add other placeholders
  without wiring the same minimal substitution.
- All dynamic content (plan items, source texts, JD digest, output language,
  page budget) is assembled in the task modules' `buildPrompt` functions, not
  here.
- **After any edit, re-baseline the benchmark**: the content hash
  (`computePromptSetVersion`) is recorded in pinned baselines, and a run
  against a baseline pinned with different prompt bytes is skipped with a
  re-pin instruction. Run `npm run benchmark -- --update-baseline` on a
  complete live run, and verify the keyless gate:
  `npm run benchmark -- --keyless`.
- These are developer-controlled artifacts — do not expose them in the UI or
  Settings.
