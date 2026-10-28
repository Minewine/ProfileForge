# Feature Specification: Evaluation Benchmark

**Feature Branch**: `009-evaluation-benchmark`

**Created**: 2026-10-28

**Status**: Draft

**Input**: User description: "Add an Evaluation benchmark module that measures generation quality and Fact Guard effectiveness against a fixed set of profile + JD fixtures. It should catch regressions in prompt changes or model swaps and reinforce the zero-invention guarantee."

**Context**: All eight shipped slices deliver the full journey (profile → matching → generation → gated export), but nothing *measures* output quality against real AI-model behavior. The zero-invention guarantee is enforced by design and exercised by automated tests with mocked AI responses plus manual spot checks — no systematic measurement exists. Two known change classes can silently degrade quality: edits to AI task prompts and model swaps in Settings. The master specification (§3 Core Modules) defines an **Evaluation** module (`runBenchmark()`) as the regression-testing backbone; it is the only core module with no implementation. This slice delivers it as a maintainer-facing harness over a fixed, version-controlled fixture set (see CONSOLIDATION.md, recommendation R3). The benchmark observes and measures existing product behavior; it never changes it.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - One-command benchmark run with a reproducible report (Priority: P1)

A maintainer starts a benchmark run with a single command. The benchmark executes the application's real, unmodified analysis → matching → generation → Fact Guard → rendering pipeline for every fixture in the fixture set (profile + job-description pairs in English and French), using an explicitly configured AI model per task — not any user's stored settings — in an isolated workspace that never touches real user data. When the run finishes, the maintainer has one report that covers **every** fixture with per-metric values, aggregate scores, and full run metadata (fixture-set version, model configuration, code state, date, duration, token usage and spend), ending in an explicit overall verdict: pass, regressed, or incomplete. Repeating the run with the same inputs and models reproduces every deterministic metric exactly.

**Why this priority**: Every other capability in this slice reads from this report. Without a trustworthy, complete, reproducible run there is nothing to compare, nothing to gate on, and no measurement of the guarantee.

**Independent Test**: Can be fully tested by running the benchmark once with valid AI credentials and verifying the report covers 100% of fixtures with all metadata present, then running it again unchanged and confirming identical deterministic metric values.

**Acceptance Scenarios**:

1. **Given** the fixture set and valid AI credentials, **When** the maintainer runs the benchmark, **Then** a report is produced within the time and spend budget, containing a result for every fixture, per-metric values, aggregate scores, complete run metadata, and an overall verdict.
2. **Given** two consecutive runs with identical fixture set and model configuration, **When** their reports are compared, **Then** every deterministic metric has exactly the same value in both runs.
3. **Given** the AI provider fails partway through a run, **When** the run ends, **Then** fixtures affected by the failure are marked failed with the cause, the report is labeled incomplete, the verdict is not "pass", and no failed fixture is silently omitted.

---

### User Story 2 - Measuring the zero-invention guarantee and Fact Guard effectiveness (Priority: P1)

The report quantifies the product's core trust promise instead of assuming it. For every generated document the benchmark measures the **grounded-claim rate**: the share of material claims that resolve to valid profile evidence or recorded user confirmation. The fixture set additionally contains **corrupted variants** — documents with deliberately introduced, labeled violations (altered numbers or dates, a fabricated employer or skill, a meaning-drifted rewrite, an unverified skill claim) — and the benchmark verifies Fact Guard catches each class and blocks the download. The meaning-check layer's fail-closed behavior is verified too: when that layer cannot run, nothing downloadable is produced. Selection integrity is measured as well: the union of draft and omissions covers the profile, and every omission carries its reason.

**Why this priority**: The zero-invention guarantee is the product's non-negotiable promise; this is the only slice capability that actually measures it end-to-end against real generated content rather than mocked responses.

**Independent Test**: Can be fully tested by running the benchmark and checking the report's Fact Guard section: grounded-claim rate per fixture, a per-class catch rate for every corrupted variant, and an explicit fail-closed verification result.

**Acceptance Scenarios**:

1. **Given** a generated document from a healthy fixture, **When** it is measured, **Then** the report states the grounded-claim rate and lists every claim that failed to resolve (if any).
2. **Given** each corrupted variant in the fixture set, **When** Fact Guard evaluates it, **Then** the document is blocked and the specific planted violation class is flagged as caught.
3. **Given** a deterministic violation class (numbers/dates altered, fabricated entries, unverified skills), **When** Fact Guard evaluates the corrupted variant, **Then** the violation is always caught — a deterministic violation passing undetected fails the run outright.
4. **Given** the meaning-check layer is unavailable, **When** a document would otherwise download, **Then** no artifact is downloadable (fail-closed holds) and the run records that fail-closed behavior was verified.
5. **Given** generation results for a fixture, **When** selection is measured, **Then** draft plus omissions cover the whole profile and every omission carries its reason (`selection` or `page_budget`).

---

### User Story 3 - Baseline comparison and regression gating (Priority: P2)

When a stored baseline exists for the current fixture-set version, each run is compared against it per metric and per fixture. Deterministic metrics have zero tolerance — any difference is a regression. Model-dependent metrics (e.g., requirement coverage that depends on live extraction) are compared against documented thresholds rather than exact equality. A run whose results cross a regression threshold is flagged in the report and exits with a failure status, so automation can gate on it. Without an applicable baseline the run still produces a full report but states plainly that comparison was skipped and why. Updating a baseline is always an explicit act that gets recorded (when, by whom, which models) — never a silent overwrite.

**Why this priority**: This turns measurement into protection — the "catch regressions" half of the goal. It depends on Stories 1–2 but is the reason they exist; without it the benchmark is informative only, not a gate.

**Independent Test**: Can be fully tested by pinning a baseline, temporarily degrading a prompt or model configuration so a metric crosses its threshold, re-running, and confirming the report flags the exact metric/fixture and the run exits with failure.

**Acceptance Scenarios**:

1. **Given** a stored baseline for the current fixture-set version, **When** a run's metric regresses beyond that metric's threshold, **Then** the report flags the regression per fixture and metric, and the run exits with a failure status.
2. **Given** a deterministic metric that differs from the baseline by any amount, **When** the reports are compared, **Then** the difference is flagged as a regression (zero tolerance).
3. **Given** no baseline exists for the current fixture-set version, **When** a run completes, **Then** the report states that comparison was skipped and the reason.
4. **Given** the maintainer explicitly updates the baseline, **When** the next run compares, **Then** it uses the new baseline and the update is recorded with its metadata.

---

### User Story 4 - Evaluating a model swap before committing to it (Priority: P2)

A maintainer considering a different AI model for any task (parsing-adjacent extraction, semantic proposals, drafting, meaning check) runs the benchmark once with the candidate configuration and compares the resulting report against the baseline run side by side: quality metrics, Fact Guard metrics, spend, and duration. The comparison covers every fixture, so a model that is cheaper but weaker on grounded-claim rate or requirement coverage is exposed before it ever serves a real user.

**Why this priority**: Model swaps are one of the two change classes this slice exists to make safe. It reuses the run machinery from Stories 1–3 with a different configuration; the comparison view is what makes a swap decision evidence-based.

**Independent Test**: Can be fully tested by running the benchmark with the baseline configuration and again with a candidate configuration, then verifying the two reports can be compared per metric per fixture, including spend and duration.

**Acceptance Scenarios**:

1. **Given** a candidate model configuration, **When** the maintainer runs the benchmark with it, **Then** the report records the model used for each AI task and completes within the time and spend budget.
2. **Given** run history contains a baseline run and a candidate run, **When** they are compared, **Then** quality, Fact Guard effectiveness, spend, and duration are presented side by side per metric across all fixtures.

---

### User Story 5 - Keyless mode for the deterministic stages (Priority: P3)

Without any AI credentials, a maintainer (or an automation runner) can still run a meaningful benchmark: the deterministic stages — matching, content selection, the deterministic Fact Guard layer, and render verification — execute over the fixture set using pinned, recorded AI responses from an earlier live run. The report is unmistakably labeled as covering deterministic stages only, so nobody mistakes it for a full evaluation of live model behavior.

**Why this priority**: It keeps the benchmark runnable in credential-less environments (fresh checkouts, automation), but it cannot catch prompt or model regressions — the primary goal — so it ranks below every live-run capability.

**Independent Test**: Can be fully tested by running the benchmark with no AI credentials configured and verifying it completes over the whole fixture set using recorded responses, exercises all deterministic stages, and is labeled "deterministic stages only".

**Acceptance Scenarios**:

1. **Given** no AI credentials are configured, **When** the maintainer runs the keyless mode, **Then** matching, selection, deterministic Fact Guard checks, and render verification all execute across the fixture set and a report is produced.
2. **Given** a keyless-mode report, **When** anyone reads it, **Then** the report states that live AI stages were not evaluated — it can never be confused with a full live run.

---

### Edge Cases

- What happens when the spend cap is hit mid-run? The run aborts cleanly, the report is marked incomplete with spend-so-far stated, and the exit status signals failure.
- What happens when a fixture is genuinely hard for the pipeline (e.g., a deliberately thin profile that cannot fill a one-page budget)? Each fixture documents its expected behavior for such conditions; the result is recorded against that expectation — never silently skipped.
- What happens when the fixture set is edited? Existing baselines are bound to a fixture-set version and are no longer applicable; comparison is refused with an explanation until a new baseline is explicitly pinned.
- What happens when a model repeatedly returns malformed output for a fixture? The fixture is marked failed with the cause after the pipeline's own retries; the report is incomplete rather than filled with fabricated values.
- What happens when the AI provider returns nondeterministic results across runs? Only threshold-based comparison applies to model-dependent metrics; exact-equality expectations are confined to deterministic metrics, and the report distinguishes the two categories.
- What happens when every fixture fails? The verdict is a clear overall failure with the dominant cause surfaced — not an empty report that looks like success.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The system MUST run the complete benchmark — every fixture, all measured stages — from a single command and produce one report.
- **FR-002**: The fixture set MUST be fixed and version-controlled, containing at least two profile fixtures (English and French, including at least one edge profile such as thin or date-ambiguous content) and at least three job-description fixtures (English and French, including one hard-constraint-heavy and one poor-match posting); each fixture MUST document its purpose and expected characteristics.
- **FR-003**: The benchmark MUST execute the application's real, unmodified pipelines (analysis → matching → generation → Fact Guard → rendering) in an isolated workspace — never a parallel reimplementation, and never reading or writing real user data.
- **FR-004**: The benchmark MUST run with an explicitly configured AI model per task, independent of any stored user settings, overridable per run.
- **FR-005**: The benchmark MUST measure generation quality at minimum: requirement coverage from the match report surfaced in the generated CV, evidence grounding of selected content, professional-summary length compliance, output-language correctness for the job's language, final page-budget compliance, and selection integrity (draft + omissions cover the profile; every omission has a reason).
- **FR-006**: The benchmark MUST measure Fact Guard effectiveness at minimum: grounded-claim rate per document, per-class catch rate on corrupted variants, and verification that the fail-closed behavior holds when the meaning-check layer cannot run.
- **FR-007**: The fixture set MUST include deliberately corrupted document variants with labeled, known violations (altered numbers/dates, fabricated employer or skill, meaning-drifted rewrite, unverified skill claim) used to verify Fact Guard catches each class.
- **FR-008**: All metrics MUST be computed deterministically from run artifacts; model-assisted judging MUST NOT be used to compute or gate v1 metrics.
- **FR-009**: The report MUST contain per-fixture and aggregate metric values, run metadata (fixture-set version, per-task model configuration, code state identifier, date, duration, token usage, spend), and an explicit overall verdict (pass / regressed / incomplete).
- **FR-010**: When a baseline exists for the current fixture-set version, the report MUST compare every metric against it using per-metric thresholds; deterministic metrics MUST have zero tolerance, and model-dependent metrics MUST use documented thresholds.
- **FR-011**: The run MUST exit with a failure status when the verdict is regressed or incomplete, and success only when the run is complete and not regressed, so automation can gate on it.
- **FR-012**: Baseline updates MUST be explicit and recorded (date, trigger, model configuration); a run without an applicable baseline MUST state that comparison was skipped and why.
- **FR-013**: The benchmark MUST enforce a per-run spend cap; exceeding it MUST abort the run, mark the report incomplete, and state the spend so far.
- **FR-014**: The benchmark MUST offer a keyless mode that evaluates the deterministic stages only, using pinned recorded AI responses from an earlier live run, with the report clearly labeled as covering deterministic stages only.
- **FR-015**: Run reports MUST be retained and identifiable so that any two runs can be compared later.

### Key Entities *(include if feature involves data)*

- **Benchmark Fixture Set**: the versioned collection of inputs — profile fixtures (structured, bilingual, including edge cases), job-description fixtures, and corrupted document variants — where each member documents its purpose and expected characteristics.
- **Benchmark Run**: one execution of the benchmark: its configuration (per-task models, spend cap), when it ran, and its results per fixture and stage.
- **Benchmark Report**: the output of a run — per-fixture and aggregate metrics, run metadata, comparison outcome, and the overall verdict.
- **Baseline**: a designated stored report used as the comparison reference, bound to one fixture-set version.
- **Metric Definition**: the documented contract for one metric — what it measures, how it is derived from run artifacts, whether it is deterministic or model-dependent, and its regression threshold.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A full live benchmark run completes in 15 minutes or less and costs no more than $1.00 at the default fixture set and model configuration.
- **SC-002**: Every fixture produces a recorded result in every report — 100% fixture coverage, with failures recorded as failures, never as silent omissions.
- **SC-003**: Every deterministic violation class is caught in 100% of evaluations; any single deterministic violation passing undetected fails the run outright.
- **SC-004**: Two runs with identical inputs and model configuration produce identical values for all deterministic metrics.
- **SC-005**: A deliberately introduced quality regression (a prompt change or model configuration that pushes any metric past its threshold) is detected and fails the run within one run cycle.
- **SC-006**: A maintainer can compare two model configurations side by side — quality, Fact Guard effectiveness, spend, and duration — from retained run history without re-running either.
- **SC-007**: The keyless mode completes with zero AI credentials configured and exercises every deterministic stage across the whole fixture set.

## Assumptions

- The primary actor is the project maintainer; this is a development tooling slice, not an end-user feature, and has no user-facing UI.
- The measured journey starts from structured profile fixtures; CV upload/parse is not benchmarked (the request specifies "profile + JD fixtures"), and profile fixtures are pre-structured rather than sourced from CV documents.
- Version 1 metrics are deterministic and computed from existing pipeline artifacts; model-assisted (judge-style) evaluation is deferred.
- Live runs use the same AI provider the product already uses, with credentials supplied by the person or system running the benchmark; the fixture set is sized to keep runs within the SC-001 budget.
- Existing Fact Guard semantics (blocker classes, explicit confirmation, fail-closed downloads) are the reference behavior being measured; this slice does not change product behavior.
- Regression thresholds for model-dependent metrics are calibrated when the first baseline is pinned, then documented in the metric definitions.

### Out of Scope

- Any change to product behavior — the benchmark only observes and measures what the shipped pipelines already do.
- Automatic prompt tuning, optimization, or A/B experimentation.
- Model-assisted (LLM-as-judge) scoring.
- Wiring the benchmark into CI pipelines — the run is gateable by exit status (FR-011), but CI integration remains deferred as it was in feature 004.
- Load, performance, or concurrency testing.
- Benchmarking the CV upload/parse stage.
