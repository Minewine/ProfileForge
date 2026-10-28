# Research: CV Ingestion & Structured Profile Foundation (Slice 1)

**Date**: 2026-10-21 · All NEEDS CLARIFICATION items resolved; no unknowns remain in Technical Context.

## R1: PDF text extraction (per page, server-side)

- **Decision**: `unpdf` for PDF text extraction with per-page output (`extractText(pdf, { mergePages: false })`).
- **Rationale**: Serverless-safe PDF.js build that works in Next.js route handlers with zero worker/webpack configuration (the main pain point of raw `pdfjs-dist` in Next.js); returns text per page, which we need for provenance locators (page number) and for the source-containment check. No native dependencies; actively maintained; TypeScript-first.
- **Alternatives considered**: `pdfjs-dist` directly (full control, positioned text items — but requires legacy build + worker config in Node/Next.js; not needed since layout analysis is the LLM's job); `pdf-parse` (single-page-oriented, weak per-page API, less maintained). Note: Next.js route handlers have a default body-size limit — local-first deployment relaxes this, but the upload route must still enforce our own 10 MB cap (FR-001) before buffering.

## R2: DOCX text extraction

- **Decision**: `mammoth` (DOCX → raw text and HTML) with paragraph structure retained.
- **Rationale**: De-facto standard for DOCX text extraction in Node; preserves paragraph boundaries, which map naturally to bullets and section headings for provenance locators (paragraph index).
- **Alternatives considered**: `docx4js` (stale), unzipping + XML parsing by hand (fragile).

## R3: Language detection (French/English)

- **Decision**: Deterministic library-based detection (`franc` on concatenated document text, threshold-gated) — not an LLM call. Result stored on `SourceDocument` and copied to `Profile.language`; always user-correctable (FR-030).
- **Rationale**: Deterministic and reproducible (matches the deterministic-core principle), zero cost, zero latency; CVs are long enough for reliable n-gram detection. LLM detection would add cost and nondeterminism for no benefit. Mixed-language CVs resolve to the dominant language (edge case in spec); technical terms stay as written.
- **Alternatives considered**: LLM-based detection (rejected: cost + nondeterminism); custom stopword heuristics (rejected: reinventing franc).

## R4: OpenRouter structured outputs & JSON enforcement

- **Decision**: Use chat completions with `response_format: { type: "json_schema", strict: true, json_schema: { name, schema } }` plus `provider: { require_parameters: true }`; **always** validate the parsed response with the task's zod schema; on failure, retry with a bounded repair prompt (max 2 retries) that includes the validation errors; then fail with a typed error.
- **Rationale**: OpenRouter documents structured outputs via `response_format` `json_schema` with `strict`, but support is **per provider endpoint** and "exact compliance is not guaranteed on every endpoint" — strict mode is a hint on some backends. `require_parameters: true` routes only to providers honoring the parameter. Zod + bounded repair makes the contract locally enforced regardless of provider behavior (deterministic core, FR-014-style guarantees start here).
- **Alternatives considered**: Prompt-only JSON with regex extraction (fragile); OpenAI SDK function-calling semantics through OpenRouter (equivalent, but json_schema is provider-portable across both tiers).

## R5: Usage tracking and the $0.50 per-run cost cap

- **Decision**: Every OpenRouter response includes a `usage` object with token counts and USD cost; the router logs each call (task, model, tokens, cost, run id) to `LlmUsageLog` and accumulates cost per run; when a run's accumulated cost reaches the configured cap (default $0.50, FR-008), further calls in that run are refused with an actionable error. Usage is surfaced per run in the UI.
- **Rationale**: Confirmed by OpenRouter docs/blog — per-response `usage.cost` (USD) exists; OpenRouter charges requests at completion, so a client-side pre-call check + post-call accumulation is the correct app-level guard. OpenRouter-side per-key credit limits exist as a backstop but are account configuration, not app behavior.
- **Alternatives considered**: Token counting + price tables (duplicative — provider already reports cost); no cap (rejected by FR-008 decision).

## R6: Key validation, storage, and secrecy

- **Decision**: Key resolution order: `OPENROUTER_API_KEY` env var → encrypted value in `AppSettings` (AES-256-GCM with a local secret from `APP_SECRET` or an auto-generated `.appsecret` file, gitignored). Validation: `GET /api/v1/auth/key` with the Bearer key (also usable as the validate-key endpoint's backend check). Stored key is never returned in full — only masked (`sk-or-…1234`); excluded from logs, errors, and LLM payloads by a redaction helper applied at the logger boundary.
- **Rationale**: Env-var path satisfies the single-user prototype decision (FR-029); encrypted DB path satisfies FR-006/FR-007 for users who prefer the settings UI. OpenRouter's auth-key endpoint validates without spending tokens.
- **Alternatives considered**: Plain-text DB column (violates FR-009); env-only (rejected: spec explicitly allows in-app setting).

## R7: Model defaults (two tiers, configurable)

- **Decision**: Task→tier map: `parseCV` → economy tier; `extractRequirements`, `factGuard` → economy; `generateTailoredCV`, `generateCoverLetter` → premium (later slices). Defaults are stored in `AppSettings` and are user-selectable via a searchable model picker (Settings UI, backed by `GET /api/v1/models`). Decided defaults (user, 2026-10-21): economy `minimax/minimax-m3.1-flash:free` (free tier — parsing/extraction stay cost-free), premium `anthropic/claude-sonnet-4.5`. If a chosen model lacks `structured_outputs` support, the Settings save rejects it with an actionable message.
- **Rationale**: FR-008 decision (two-tier, configurable); model IDs drift quickly, so the plan pins the *selection procedure* (verify against the models endpoint) rather than eternally-valid IDs.
- **Alternatives considered**: Single model (rejected in clarification); hardcoding IDs in code (rejected: config drift).

## R8: Zero-invention enforcement at ingestion (source-containment check)

- **Decision**: After the LLM returns a ProfileDraft, every parsed bullet and material field is verified against the extracted source text with normalized comparison (case-, accent-, whitespace-, punctuation-insensitive; ≥95% word-level containment per bullet — mirroring FR-021's normalization). Bullets/fields that fail containment are not silently accepted: they are either dropped or marked `confidence: low` with a containment warning, and the entry is flagged for user review (becomes valid only after user confirmation → provenance `user_confirmed`).
- **Rationale**: The spec's first non-negotiable principle (zero invented facts, claim-level provenance) must hold from day one, even though the full Fact Guard ships with generation in Slice 3. This check is deterministic, testable, and reuses the same normalization the later export gate uses.
- **Alternatives considered**: Trusting the LLM's parse (violates principle 1); deferring all validation to Slice 3 (leaves the foundation unguarded).

## R9: Date normalization (EN/FR → YYYY-MM)

- **Decision**: Dedicated deterministic normalizer (no LLM) mapping English and French formats: month names/abbreviations ("Jan"/"janv.", "Sept"/"sept."), numeric formats ("01/2023", "2023-01", "2023/01"), ranges ("2023 – present", "depuis 2020", "sept. 2021 – aujourd'hui"), and "present"/"présent"/"aujourd'hui" → `present`. Ambiguous inputs (e.g., "01/02/2023" day/month order, undated roles) produce `null` + a low-confidence flag instead of a guess (FR-004). Unit-tested against a fixture table.
- **Rationale**: Deterministic core; dates feed scoring, page budgets, and ATS checks later — errors here compound. LLM normalization is used only to *locate* date strings during parsing; the conversion itself is code.
- **Alternatives considered**: LLM-normalized dates (nondeterministic, unverifiable); date-fns parse (no FR locale month handling out of the box for abbreviations we need; thin wrapper is still required).

## R10: Profile versioning & snapshots

- **Decision**: `Profile.version` integer incremented on every persisted mutation; each increment writes an append-only `ProfileSnapshot` row (full profile JSON, version, cause: `import | edit | restore`). MatchReports and generated documents (later slices) pin `profileVersion`; ingestion jobs snapshot the profile at start (FR-027).
- **Rationale**: Makes provenance and later traceability reproducible; enables restore ("omissions reversible" cousin) and benchmark determinism. JSONB snapshots avoid brittle history tables at MVP scale.
- **Alternatives considered**: Event-sourced history (over-engineered for one user); no versioning (breaks FR-027).

## R11: Parse flow: synchronous upload, isolated slow parse

- **Decision**: `POST /api/cv/upload` does file save + text extraction + language detection synchronously (<5 s). `POST /api/cv/[id]/parse` runs the LLM parse as a single long request (≤120 s) with a client-side progress state; the full async job lifecycle (states, retries, cancellation) arrives with generation in Sprint/Slice 3.
- **Rationale**: Slice 1 has exactly one slow operation; a job queue now is speculative infrastructure. The service layer (`parseCV` as a pure-ish function over extracted text) keeps the async wrapper a thin addition later.
- **Alternatives considered**: Job table + polling now (deferred need); streaming parse (no benefit for a single structured result).

## R12: Testing approach

- **Decision**: vitest; unit tests for normalizer/detector/containment/key-masking; integration tests invoking route handlers directly against an isolated test database (migrations applied); LLM router tested with `fetch` mocked (schema-pass, schema-fail→repair, cap-hit, 401/402/429 error mapping). Fixtures: EN/FR PDFs, EN/FR DOCX, image-only PDF (assert rejection), oversized stub.
- **Rationale**: No browser e2e needed to prove this slice's contracts; keeps the suite fast and deterministic. Global repo convention (pytest) does not apply — stack is locked TypeScript.
- **Alternatives considered**: Jest (slower TS defaults), Playwright (valuable later for editor flows; not required to validate slice contracts).

## Sources

- OpenRouter structured outputs: https://openrouter.ai/docs/features/structured-outputs
- OpenRouter usage/cost + limits: https://openrouter.ai/docs/api_reference/limits , https://openrouter.ai/blog/tutorials/team-spend-controls-setup
- unpdf: https://github.com/unjs/unpdf , comparison: https://www.pkgpulse.com/guides/unpdf-vs-pdf-parse-vs-pdfjs-dist-pdf-2026
