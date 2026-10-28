# Research — Slice 3: Evidence-Aware CV & Cover Letter Generation

Phase 0 design decisions. Each resolves an open question from the plan's Technical Context or spec; format follows `specs/002-jd-matching/research.md`. Binding inputs: `specs/003-cv-generation/spec.md` (FR-001–FR-020), `ProfileForge-Specification.md` §4/§6/§7, parent-spec Clarifications (2026-10-21).

---

## R1: PDF rendering library

**Decision**: Promote `pdf-lib` (currently a devDependency used only by `scripts/make-fixtures.mjs`) to a runtime dependency and build the single-column ATS template directly on it.

**Rationale**: pdf-lib draws every string as a real text-layer object — the extraction gate can then be a genuine post-hoc verification rather than a hope. It gives exact, deterministic control over single-column layout, fonts, and pagination (needed by the measure-and-demote fitting loop, R9), needs no browser binary, and is already vendored in the repo (fixtures prove it emits parseable PDFs — `npm run fixtures` output passes `unpdf` extraction today).

**Alternatives considered**: Headless-Chrome HTML→PDF (puppeteer/playwright — heavy new runtime deps, font/ATS behavior harder to guarantee, layout less deterministic); `pdfkit` (viable but a brand-new dependency where pdf-lib is already present); hand-rolled PDF writer (unjustified complexity).

---

## R2: Extraction-gate implementation

**Decision**: Reuse the existing stack: `unpdf` (`src/lib/parsing/pdf.ts:extractPdfPages`) to extract the rendered PDF's text; level 1 (structural) via normalized presence checks for name, each contact item, every rendered section heading, and each rendered experience entry's company/title/dates; level 2 (per-block ≥95% word recovery) via the existing `checkContainment` (`src/lib/validation/sourceContainment.ts`, threshold already 0.95, already case/accent/punctuation-insensitive via `normalizeText`).

**Rationale**: The parent's clarified gate definition maps 1:1 onto utilities the codebase already has; identical normalization for FR and EN falls out of `normalizeText` for free (NFD mark-stripping). One comparison definition for containment (slice 1) and the export gate (slice 3) keeps the "95%" in the product promise unambiguous.

**Alternatives considered**: `pdf-parse` (duplicate of what unpdf provides); a separate normalization implementation for the gate (risks divergence from the slice-1 containment rule); OCR-based verification (out of scope, unnecessary for text-layer PDFs).

---

## R3: DOCX export

**Decision**: Promote `docx` (devDependency, also fixtures-only) to a runtime dependency; render a best-effort DOCX from the same structured content; explicitly ungated by the extraction check (decided parent exception); download still blocker-gated like every artifact.

**Rationale**: Parent decision (2026-10-21) already settled DOCX as an ungated convenience output; the library is present and proven by the fixture generator. Rendering from the same content object (not from the PDF) keeps one source of truth.

**Alternatives considered**: Gating DOCX too (explicitly rejected by parent decision); generating DOCX via LibreOffice conversion (new system dependency); dropping DOCX (parent decision includes it in MVP).

---

## R4: Async job pattern

**Decision**: DB-backed job rows + in-process execution + client polling. `POST /api/generations` validates preconditions, creates a `GenerationJob` (status `queued`), kicks off `pipeline.ts` without awaiting it, and returns `202` immediately. The client polls `GET /api/generations/[id]`. Cancellation sets `cancelRequested`, checked between stages and before each LLM call. Failure states persist `statusError` and are retryable (`POST .../retry` bumps `attempt`, fresh cost-cap `runId`). On server start (and lazily on first list/read), jobs left `running` from a dead process are marked failed with an interrupted error so no job hangs forever.

**Rationale**: Spec FR-001 requires visible async status, retry, and cancellation — the synchronous await-in-handler pattern used by slices 1–2 cannot cancel server-side or report progress. Single-user local-first means in-process execution is correct; a real queue (BullMQ/Redis or a worker process) adds infrastructure the deployment boundary (§9) explicitly avoids. The state-machine + retryable-failed + `statusError` idioms copy `JobAnalysis` exactly.

**Alternatives considered**: Keep synchronous handlers (violates FR-001); SSE/WebSocket progress (polling suffices for a 1-user app; SSE adds connection lifecycle complexity under `cacheComponents`); Redis-backed queue (new infra, overkill). Risk noted: vitest's 30 s timeout and serial execution — pipeline tests must await job completion via the repository with mocked LLM (deterministic, fast), not wall-clock polling loops.

---

## R5: Profile pinning semantics

**Decision**: Pin the profile snapshot at **job start** (current `profile.version` at creation, per FR-002), not the analysis's match-time version. MatchReport evidence references are resolved against that pinned snapshot; references that no longer resolve (entry deleted since the match) are skipped from the relevance ranking with a stored `stale-analysis` notice on the job advising a re-match. Content is always read from the pinned `ProfileSnapshot.data` — later edits never affect an in-flight or stored result.

**Rationale**: FR-002's wording is "snapshot taken at job start"; it also lets users enrich the profile and generate without re-matching. Dangling match references are exactly the honest-degradation case: skip + notice, never fabricate or crash. Full snapshots already exist (`ProfileSnapshot.data` JSONB), so no new snapshot machinery is needed.

**Alternatives considered**: Pinning to `analysis.profileVersion` (guarantees all evidence resolves, but contradicts FR-002's "job start" and forces a re-match after every profile edit); re-matching automatically on staleness (out of scope, surprising cost); blocking generation on staleness (unnecessarily strict — ranking degrades gracefully).

---

## R6: Persistence shape

**Decision**: Three Prisma models with JSONB payloads, following slice-2 R6: `GenerationJob` (lifecycle + settings + pinned version + runId), `GeneratedDocument` (stable identity per `(analysisId, kind)` + cross-version confirmation fingerprints), `GeneratedDocumentVersion` (content JSONB = canonical GeneratedCVContent / CoverLetterContent with omissions and provenance, validationReport JSONB, artifacts JSONB with sha256/size/gate result, producing job FK, `@@unique([documentId, version])`).

**Rationale**: Documents are per-analysis-per-kind entities whose settings evolve across regenerations (FR-018's version chain); jobs are executions. JSONB mirrors the proven `JobAnalysis.matchReport` pattern and keeps the canonical §4 schemas as the single authority — normalized flag/omission tables would add joins without adding integrity, exactly the trade-off slice 2 already made. Versions are immutable except claim-resolution edits, which bump a revision counter and rewrite `validationReport` (R10).

**Alternatives considered**: One model (job = version) — breaks FR-018's version chain and confirmation carryover; fully normalized tables — rejected as above; storing artifact bytes in Postgres — files on disk match the existing `files/storage.ts` convention and keep large blobs out of the DB.

---

## R7: Evidence-aware selection — deterministic plan, keyed LLM draft

**Decision**: Split selection from writing, mirroring slice 2's propose–validate philosophy. `plan.ts` builds a fully deterministic ordered `ContentPlan`: per-entry score = weighted sum of relevance (MatchReport evidence links + normalized keyword overlap with requirements/recommendedKeywords), evidence strength (number of evidence refs, provenance confidence, `containmentOk`), impact (presence of quantified outcomes — numbers/percentages in the source text), and recency (entry end date), with fixed tunable constants documented in `contracts/generation-pipeline.md`. The skills section is entirely deterministic (exact/approved-alias matched skills rendered in JD terminology, capped by fitting). The premium LLM task receives plan items **keyed by id** with their source text and returns rephrased/translated text **per key**; `draft.ts` merges by key, attaching provenance (`sourceBulletIds`/`EvidenceRef`) from the plan itself. Unkeyed output items are dropped; keys the LLM skipped fall back to the verbatim source text (translation then handled as an explicit warning-flagged path). The LLM can never introduce a claim: it can only rewrite items the deterministic plan selected.

**Rationale**: FR-003/FR-004 require ranking and provenance that survive audit; making both deterministic makes SC-002 testable without trusting model output. Keyed drafting is the strongest anti-hallucination mechanism available — provenance never passes through the model. Verbatim fallback keeps a missing key honest (original text in source language) instead of dropping content silently.

**Alternatives considered**: LLM-driven selection (non-deterministic, unauditable, provenance would be model-claimed); pure-deterministic CV with no LLM prose (fails the "tailored, output-language narrative" requirement); embeddings for relevance (deferred by parent scope).

---

## R8: Fact Guard layering, codes, and fail-closed semantics

**Decision**: Two layers. **Deterministic (no AI, always runs):** `DANGLING_PROVENANCE` (claim's sourceBulletIds/EvidenceRefs don't resolve in the pinned snapshot), `UNSUPPORTED_CLAIM` (material claim with empty/unresolvable provenance), `NUMERIC_MISMATCH` (numbers, years, percentages, durations extracted from the claim text do not all appear in the cited evidence under normalization), `SKILL_UNVERIFIED` (skills-section entry that is neither a profile skill nor an exact/approved-alias match) — all blockers. **Semantic (economy-tier `factGuard` task):** per-claim meaning-preservation verdict → `MEANING_DRIFT` blocker on drift; LLM may also emit `UNCERTAIN_TRANSLATION` (warning) for credential/proper-noun translations it cannot map faithfully. Warnings never block. If the semantic layer cannot run (AI failure), export is blocked with `FACTGUARD_UNAVAILABLE` while deterministic results remain visible (FR-010 fail-closed); the job itself still completes — only download is gated, so the user can retry validation without re-paying generation.

**Rationale**: FR-008 mandates the two layers; the deterministic layer must run without AI so reference/numeric violations surface even during outages. Numeric identity across translation (FR-015) is only trustworthy as a string/number comparison, not a model judgment. Blocking download rather than failing the job separates "content exists" from "content is certified" — matching FR-009's "prevent download until resolved".

**Alternatives considered**: Single LLM-only guard (non-deterministic, unavailable during outages); deterministic-only guard (cannot catch meaning drift in rephrasing — the spec's semantic-fidelity requirement); failing the whole job on semantic-layer outage (wastes the premium generation cost; download gate is the spec's actual mechanism).

---

## R9: Page-budget fitting and the restored-item conflict

**Decision**: Fitting is a measure-and-demote loop after content selection (FR-003): render to PDF, measure pages; while over budget, demote the lowest-ranked demotable item (whole entry first if its section allows, then bullets) to the omissions list with reason `page_budget`, and re-render. Restored omissions are must-include: before drafting, `plan.ts` pre-checks that the must-include set alone fits the budget (conservative height estimate); if not, the job fails fast with `PAGE_BUDGET_CONFLICT` and an actionable message (raise budget or trim) — never a silent re-omission (SC-006).

**Rationale**: pdf-lib rendering is deterministic and cheap, so iterative measurement is exact (no estimates in the common path); demotion order falling out of the same ranking keeps "strongest evidence survives" true by construction. The pre-check turns the spec's conflict case into an explicit, early, cheap failure instead of a post-render surprise.

**Alternatives considered**: Estimated heights without rendering (inaccurate — pdf-lib measurement is available and exact); LLM-driven trimming (violates determinism of selection); letting must-include items overflow (violates the page budget) or silently re-omitting them (violates SC-006).

---

## R10: Claim resolution and confirmations across regeneration

**Decision**: Claims are addressed by stable ids within a version (`summary`, `exp.{experienceId}.{n}`, `edu.{id}`, `proj.{id}.{n}`, `cert.{id}`, `letter.{n}`). PATCH replaces text (resolution `edited`), DELETE removes the block (resolution `removed`), POST confirm records `user_confirmed`; each edit/remove triggers re-validation of both Fact Guard layers for the version and rewrites `validationReport`. Confirmation fingerprints (hash of normalized claim text + sorted evidence ids) are stored on the `GeneratedDocument`; when a later version contains a claim with an identical fingerprint, its flag auto-resolves to `user_confirmed` (attributed to the original confirmation timestamp). Changed claims are always re-validated fresh.

**Rationale**: FR-009's resolution states and the spec's assumption "confirmations persist across regeneration only for claims whose text and evidence are unchanged" need an identity notion; fingerprints implement exactly that predicate. Editing structured content (not the rendered PDF) preserves the parent's no-freeform-rendered-edit rule.

**Alternatives considered**: Confirmations per version only (forces pointless re-confirmation on identical content); confirming whole documents (too coarse — one changed bullet would invalidate everything); applying confirmations to changed claims (unsafe).

---

## R11: Cover letter pipeline and complementarity

**Decision**: The cover letter is a second `kind` on the same pipeline with: tone setting (default `professional`), one-page budget (fixed default, not user-facing in this slice), the same plan→draft→guard→render→gate stages, plain-text artifact, and a deterministic complementarity check — no rendered letter paragraph may reach ≥0.95 normalized word-containment against any current-CV bullet or the CV summary (violation = `LETTER_DUPLICATES_CV` blocker; verbatim reuse is what FR-016 forbids). The LLM input includes the current CV version's bullet texts so it can actively avoid repetition.

**Rationale**: FR-016/FR-017 reuse every CV mechanism; the only new rule is complementarity, which is checkable deterministically with the same containment primitive. One page is the documented spec default.

**Alternatives considered**: A separate letter-specific pipeline (duplicates everything); LLM-only "don't repeat" instruction without a check (unverifiable — SC-008 demands an automated overlap check); blocking near-paraphrase entirely (over-strict; the spec bans verbatim reuse, not topical overlap).

---

## R12: Artifact storage and the download gate matrix

**Decision**: Artifacts are files under `UPLOADS_DIR/generations/{versionId}/{cv|letter}.{pdf|docx|txt}` with sha256 + byte size + gate outcome recorded in the version's `artifacts` JSONB. Download gate matrix: **PDF** requires zero pending blockers AND a passed extraction check (written only after the gate passes; `EXPORT_GATE_FAILED` versions expose the check results but no file). **DOCX** requires zero pending blockers; ungated by extraction (parent exception). **TXT** (cover letter) requires zero pending blockers. Every format refuses with `BLOCKERS_UNRESOLVED` while blockers are pending, including plain-text copy.

**Rationale**: One blocker gate for all formats makes FR-009's "prevent download" airtight; per-format verification differences follow the parent's decided exception exactly. Disk storage extends the existing upload-storage convention.

**Alternatives considered**: Writing the PDF before gating (a failing artifact would exist on disk — spec says failing documents are never offered, and not writing them is the simplest reading); DB byte storage (rejected in R6); gating DOCX (rejected by parent decision).

---

### Resolved NEEDS CLARIFICATION → decision mapping

| Technical Context unknown | Resolved by |
|---|---|
| PDF rendering approach | R1 |
| Async job infrastructure | R4 |
| Extraction gate implementation | R2 |
| Document/version persistence shape | R6, R10 |
| Selection determinism vs LLM role | R7 |
| Fact Guard architecture | R8 |

No unresolved clarifications remain.
