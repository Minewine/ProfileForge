# Data Model: Evaluation Benchmark (009)

Phase 1 output. Benchmark-local entities only — no product schema changes (the benchmark reads
and writes existing product tables exclusively through shipped repository functions, as a synthetic
user, inside the benchmark database).

## 1. BenchmarkConfig (run configuration)

Validated with zod; loaded from `benchmarks/benchmark.config.json` (optional) then overridden by
CLI flags.

| Field | Type | Validation | Notes |
|---|---|---|---|
| `mode` | `"live" \| "replay"` | required, default `live` | `--keyless` forces `replay` |
| `models` | `Partial<Record<TaskId, string>>` | keys must be registered LLM task ids | written to the synthetic user's settings before cases run |
| `spendCapUsd` | number | > 0, default `1.00` | FR-013 hard abort |
| `compare` | boolean | default `true` | `--no-compare` skips baseline comparison |
| `updateBaseline` | boolean | default `false` | pins this run's report as the baseline for the fixture-set version |
| `label` | string | optional | human label stored in run metadata |
| `caseIds` | `string[]` | optional; must exist in manifest | debug subset; report is marked `partial: true` and can never verdict `pass` |

Relationships: consumed by one BenchmarkRun.

## 2. FixtureSet (versioned, immutable per version)

Derived from `benchmarks/fixtures/`.

| Field | Type | Notes |
|---|---|---|
| `version` | string | content hash of manifest + every fixture/variant file |
| `profiles` | `ProfileFixture[]` | `{ id, file, purpose, expected }` — JSON conforming to the profile draft schema; ≥ 2, covering EN and FR, ≥ 1 edge profile |
| `jds` | `JdFixture[]` | `{ id, file, language: "en"\|"fr", purpose, expected }`; ≥ 3, incl. hard-constraint-heavy and poor-match |
| `cases` | `Case[]` | `{ id, profileId, jdId, outputLanguage: "en"\|"fr"\|"de" }` |
| `variants` | `VariantDef[]` | see §3; must cover all 5 classes |

Validation rules (fail fast, exit 3): minimum counts per FR-002; every `case` references existing
profile/jd ids; every variant class present exactly once per referenced case family; `expected`
characteristics are machine-checkable fields, not prose.

## 3. VariantDef (corrupted-variant definition)

| Field | Type | Notes |
|---|---|---|
| `id` | string | |
| `class` | `altered_number \| altered_date \| fabricated_entry \| meaning_drift \| unverified_skill` | all 5 must appear (FR-007) |
| `target` | selector for the claim/bullet to mutate in the generated CV version | resolved against the case's generated version |
| `expected` | `{ blocked: true, caughtBy: "deterministic" \| "semantic" }` | `meaning_drift` expects `semantic`; all others `deterministic` |

State: none (pure definitions). Evaluation produces `VariantResult`.

## 4. BenchmarkRun

One execution. Persisted as `benchmarks/runs/<runId>/report.json` (+ `transcript.jsonl` when
recording).

| Field | Type | Notes |
|---|---|---|
| `runId` | string | `<UTC timestamp>-<label-or-slug>` |
| `startedAt` / `finishedAt` | ISO datetime | metadata only — never enters metric values (D10) |
| `codeState` | `{ sha, dirty }` | git state at run start |
| `config` | BenchmarkConfig (effective) | incl. resolved per-task models |
| `fixtureSetVersion` | string | from §2 |
| `status` | `running \| complete \| incomplete` | `incomplete` = abort/cap/provider/transcript-miss/all-cases-failed |
| `verdict` | `pass \| regressed \| incomplete` | computed only when `complete` (or forced `incomplete`) |
| `partial` | boolean | true when `caseIds` subset was run; verdict then cannot be `pass` |
| `spendUsd`, `durationMs` | number | informational; from `getRunUsage` + wall clock |

Transitions: `running → complete` (all cases evaluated) | `running → incomplete` (abort, provider
failure, transcript miss, spend cap, every case failed). A run never returns to `running`.

## 5. CaseResult (per manifest case)

| Field | Type | Notes |
|---|---|---|
| `caseId` | string | |
| `status` | `ok \| failed` | `failed` records `{ stage, cause }` (stage ∈ analysis, match, generation_cv, generation_letter, measurement) |
| `metrics` | `MetricResult[]` | see §6 and contracts/metrics.md |
| `variantResults` | `{ variantId, blocked, caughtBy, expectedCaughtBy, pass }[]` | `pass` requires blocked ∧ caughtBy = expected |
| `groundedClaimShortfalls` | claim refs | listed when grounded-claim rate < 1 (spec US2 scenario 1) |

Every manifest case MUST have a CaseResult in the report — SC-002 forbids silent omissions; a
pipeline failure is recorded as `failed`, never skipped.

## 6. MetricResult

| Field | Type | Notes |
|---|---|---|
| `metricId` | string | from the metric dictionary (contracts/metrics.md) |
| `value` | number \| boolean | rates quantized to 4 decimals |
| `category` | `deterministic \| model_dependent` | drives comparison semantics |
| `baselineValue` | number \| boolean \| null | null ⇒ comparison skipped (stated reason) |
| `comparison` | `ok \| regressed \| skipped` | deterministic: exact match required; model-dependent: threshold |

Thresholds live in the metric dictionary (code table documented in contracts/metrics.md), not in
reports — reports reference them by dictionary version.

## 7. Baseline

Persisted at `benchmarks/baselines/<fixtureSetVersion>.json` and committed.

| Field | Type | Notes |
|---|---|---|
| `fixtureSetVersion` | string | binding — comparison refuses any other version |
| `pinnedAt` / `pinnedBy` | datetime / string | "recorded update" metadata (FR-012); `pinnedBy` = `--label` or "unspecified" |
| `codeState` | `{ sha, dirty }` | provenance |
| `models` | effective model mapping | provenance |
| `cases` | `{ caseId, metrics: { metricId: value } }` | reference values |
| `dictionaryVersion` | string | metric dictionary the values were produced under |

Transitions: none → pinned (first `--update-baseline`) → superseded (fixture-set version changes;
old file remains in history). Baselines are never overwritten silently: repinning the same version
requires `--update-baseline` and produces a new `pinnedAt` record.

## 8. TranscriptStore (keyless mode)

`benchmarks/transcripts/<fixtureSetVersion>/<taskId>.jsonl` — append-only during `record`, read-only
during `replay`.

| Field | Type | Notes |
|---|---|---|
| `inputHash` | string | stable hash of (task payload, model) |
| `model` | string | model that produced the response |
| `response` | LLM response body | replayed verbatim |
| `usage` | token counts | replayed into usage accounting |

Lookup miss ⇒ `TRANSCRIPT_MISS` ⇒ case failed, run `incomplete` (never fabricated — spec edge case).

## Cross-entity invariants

1. `report.fixtureSetVersion` == baseline's (else comparison `skipped` with reason).
2. Verdict `pass` requires: `status == complete` ∧ `partial == false` ∧ every case `ok` ∧ no
   regression ∧ all `deterministic`-category metrics at their required values.
3. Any `deterministic` violation class caught = false ⇒ verdict can never be `pass` (SC-003).
4. `incomplete` status ⇒ verdict `incomplete` ⇒ exit 2 (FR-011).
5. Metric values never depend on wall-clock time or run order (D10) — only artifact contents.
