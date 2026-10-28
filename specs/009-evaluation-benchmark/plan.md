# Implementation Plan: Evaluation Benchmark

**Branch**: `009-evaluation-benchmark` | **Date**: 2026-10-28 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/009-evaluation-benchmark/spec.md`

## Summary

Deliver the master spec's Evaluation module as a maintainer-facing benchmark harness: a single
command runs the application's real analysis → matching → generation → Fact Guard → rendering
pipelines over a fixed, version-controlled fixture set (profile + JD pairs, EN/FR, plus corrupted
document variants), measures generation quality and Fact Guard effectiveness from existing pipeline
artifacts (no new AI calls for measurement), compares against a pinned baseline with per-metric
thresholds, and exits with a gateable status. Live mode uses explicitly configured models and a
per-run spend cap; keyless mode replays pinned AI responses to exercise the deterministic stages
only. Technical approach: a standalone `tsx` CLI entry composing the existing `src/lib` domain
functions directly against a physically isolated benchmark database and uploads directory — no
changes to product behavior, no new pages or API routes.

## Technical Context

**Language/Version**: TypeScript 5 (Node 20+); harness entry runs via `tsx` (same pattern as
`scripts/assign-owner.ts`)

**Primary Dependencies**: existing app stack only — zod 4 (config/report schemas), Prisma 7 +
`@prisma/adapter-pg`, `franc` (output-language metric), `docx`/`unpdf` (render + extraction gate);
no new runtime dependencies

**Storage**: PostgreSQL 16 — dedicated `profileforge_benchmark` database (reset per run) +
`uploads-benchmark/` artifacts dir; baselines, run reports, and pinned transcripts as versioned
JSON under `benchmarks/`

**Testing**: Vitest 4 (unit for metrics/comparison/fixtures; integration for runner + replay
transport against the benchmark DB with mocked/transcript LLM); existing suites must remain green

**Target Platform**: local dev machines (Linux/macOS); CI-capable via keyless mode and exit codes

**Project Type**: developer CLI tool inside the existing Next.js 16.4.2 web app repo — touches
only the `src/lib` layer, `scripts/`, and the new `benchmarks/` data directory; no App Router
surface is added or modified (no pages, no API routes), so no Next.js-specific conventions apply
beyond what `src/lib` already follows

**Performance Goals**: full live run ≤ 15 minutes wall clock; keyless run ≤ 2 minutes

**Constraints**: ≤ $1.00 default spend cap per live run (configurable, hard-abort on exceed);
physically isolated data (own DB + uploads dir, URL guard refuses anything else); zero product
behavior change; deterministic metrics bit-reproducible for identical inputs and models

**Scale/Scope**: fixture set ≥ 2 profiles + ≥ 3 JDs + ≥ 5 corrupted-variant classes; 12 documented
metrics; 1 active baseline per fixture-set version; retained run reports under `benchmarks/runs/`

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

`.specify/memory/constitution.md` is the unfilled spec-kit scaffold — no binding project gates.
The project's de-facto principles from the master specification (§2 Guiding Principles) are applied
instead:

| Principle (master spec §2) | How this plan complies |
|---|---|
| Zero invented facts | Benchmark measures grounded-claim rate and corrupted-variant catch rates; it invents nothing — every metric derives from persisted pipeline artifacts |
| ATS-first with verification | Extraction-gate results are a measured metric (`extraction_gate_ok`); corrupted render variants flow through the real gate |
| Evidence-aware relevance | Requirement coverage and selection-integrity metrics read the MatchReport and SelectionRecord |
| Transparent, deterministic matching | All scoring/comparison is deterministic; model-dependent metrics are explicitly categorized with thresholds |
| Verification over assumption | Verdict + exit status gate automation; fail-closed behavior is itself verified |

**Pre-Phase 0: PASS. Post-Phase 1 re-check: PASS** — the only product-code contact is an additive,
behavior-preserving transport injection in `src/lib/llm/router.ts` (live/record/replay); default
routing is unchanged, no route/page/schema changes.

## Project Structure

### Documentation (this feature)

```text
specs/009-evaluation-benchmark/
├── plan.md              # This file
├── research.md          # Phase 0 output: decisions & rationale
├── data-model.md        # Phase 1 output: benchmark entities
├── quickstart.md        # Phase 1 output: validation scenarios
├── contracts/
│   ├── cli.md           # Command interface, flags, exit codes, environment
│   └── metrics.md       # Metric dictionary + report document contract
└── tasks.md             # Phase 2 output ($speckit-tasks — NOT created here)
```

### Source Code (repository root)

```text
benchmarks/                        # benchmark data (versioned unless noted)
├── benchmark.config.json          # optional defaults; CLI flags override
├── fixtures/
│   ├── manifest.json              # fixture-set version (content hash), cases, expected characteristics
│   ├── profiles/*.json            # structured profile fixtures
│   ├── jds/*.txt                  # job-description fixtures
│   └── variants.json              # corrupted-variant definitions per violation class
├── baselines/                     # committed baselines, one per fixture-set version
├── runs/                          # retained run reports (gitignored)
└── transcripts/                   # pinned AI responses for keyless mode, keyed by fixture-set version

scripts/run-benchmark.ts           # CLI entry (tsx): env guard, config, orchestration, exit code

src/lib/benchmark/
├── config.ts                      # BenchmarkConfig schema + load/merge (zod)
├── fixtures.ts                    # manifest load, content-hash versioning, completeness validation
├── workspace.ts                   # benchmark DB/uploads guard + reset + synthetic benchmark user
├── runner.ts                      # one run: seed → analyze → match → generate (cv, letter) → measure
├── metrics.ts                     # metric computations from pipeline artifacts
├── variants.ts                    # corrupted-variant mutation + Fact Guard re-evaluation
├── report.ts                      # report assembly, baseline comparison, verdict
├── store.ts                       # run/baseline persistence under benchmarks/
└── transcripts.ts                 # transcript record/replay formats and lookup

src/lib/llm/transport.ts           # NEW: injectable LLM transport (live fetch | record | replay);
│                                  # router.ts wires it additively — default behavior unchanged
```

Tests follow the existing layout: `tests/unit/benchmark-*.test.ts` (metrics, comparison, fixtures,
variants — pure logic) and `tests/integration/benchmark-*.test.ts` (runner against the benchmark
DB with replayed transcripts).

**Structure Decision**: single project (existing repo). The benchmark is a new `src/lib/benchmark`
domain composed of the shipped `src/lib` functions — `importFromDraft`, `createAnalysis`,
`storeExtractedRequirements`, `matchRequirements`, `persistReport`, `createGenerationJob`,
`runGenerationJob`, `waitForJobSettled`, `runExtractionGate`, `computeDownloadable`,
`getRunUsage` — never a reimplementation, satisfying FR-003 ("real, unmodified pipelines").

## Complexity Tracking

> Filled only for justified constitution violations — none.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
