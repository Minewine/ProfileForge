# Contract: Metric Dictionary & Report Document

> **DEPRECATED (2026-10-28)**: the Fact Guard-dependent metrics are removed —
> `grounded_claim_rate`, `semantic_catch_rate`, `deterministic_catch_rate`,
> `fail_closed_verified`, and the corrupted-variant grading. The dictionary is now
> `requirement_coverage` + the six deterministic metrics. This document remains for
> historical context only.

Authoritative definitions for every measured metric (FR-005, FR-006), their comparison semantics
(FR-010), and the report document shape (FR-009). The dictionary version is stamped into baselines
(`dictionaryVersion`) so historical values stay interpretable.

## Metric categories

- **deterministic** — value is fully determined by artifact contents; identical inputs + models ⇒
  identical value (SC-004); compared with **zero tolerance**; failing its required value fails the run.
- **model_dependent** — value depends on live AI behavior; compared against a threshold; thresholds
  have documented defaults, calibrated when the first baseline is pinned (spec Assumptions).

## Dictionary v1

| id | Definition (computed from) | Category | Required / threshold default |
|---|---|---|---|
| `requirement_coverage` | share of matched requirements from the MatchReport that the final CV's claims address, counted via claim→requirement evidence links (MatchReport + GeneratedDocumentVersion) | model_dependent | ≥ baseline − 0.05 AND ≥ 0.80 absolute |
| `grounded_claim_rate` | share of material claims in the final document resolving to valid profile evidence or recorded confirmation (Fact Guard validation report over the final version + profile snapshot) | model_dependent | = 1.00 for healthy fixtures at baseline; regression threshold: ≥ baseline − 0.03 AND ≥ 0.97 absolute; any shortfall lists the offending claims |
| `selection_integrity` | draft ∪ omissions covers the whole profile (SelectionRecord + omissions list) | deterministic | must be `true` |
| `omissions_reasoned` | every omission carries reason `selection` or `page_budget` (omissions list) | deterministic | must be `true` |
| `summary_length_ok` | professional summary within the configured 30–120-word bound (generated content + settings) | deterministic | must be `true` |
| `page_budget_ok` | final rendered CV page count within the configured budget (pipeline fit result) | deterministic | must be `true` |
| `output_language_ok` | generated document language matches the case's configured output language (franc detection on output text) | deterministic | must be `true` |
| `extraction_gate_ok` | shipped extraction gate passed for the rendered PDF (verify result on the version) | deterministic | must be `true` |
| `deterministic_catch_rate` | share of corrupted variants of `altered_number`, `altered_date`, `fabricated_entry`, `unverified_skill` classes that were blocked with the expected blocker class (variant evaluation) | deterministic | must be 1.0000 — any single miss fails the run outright (SC-003) |
| `semantic_catch_rate` | share of `meaning_drift` variants blocked via the semantic layer (variant evaluation) | model_dependent | ≥ baseline − 0.10 AND ≥ 0.50 absolute |
| `fail_closed_verified` | with the meaning-check layer forced unavailable, `computeDownloadable` refuses all formats (fail-closed drill) | deterministic | must be `true` |
| `spend_usd`, `duration_ms` | run cost and wall time (usage log + clock) | informational | never gate; reported per run and compared side-by-side in model-swap evaluation |

## Report document (`report.json`)

```jsonc
{
  "schema": "profileforge.benchmark.report/1",
  "runId": "2026-10-28T09-14-07-model-swap",
  "verdict": "pass | regressed | incomplete",
  "status": "complete | incomplete",
  "partial": false,
  "fixtureSetVersion": "<content hash>",
  "dictionaryVersion": "v1",
  "codeState": { "sha": "6dccd03", "dirty": true },
  "config": { "mode": "live", "models": { "<task>": "<model>" }, "spendCapUsd": 1.0 },
  "spendUsd": 0.42,
  "durationMs": 512000,
  "comparison": { "baseline": "<version> | null", "outcome": "ok | regressed | skipped", "reason": "…" },
  "cases": [
    {
      "caseId": "en-hard-constraints",
      "status": "ok | failed",
      "failure": { "stage": "match", "cause": "…" },          // when failed
      "metrics": [
        { "metricId": "grounded_claim_rate", "value": 1.0, "category": "model_dependent",
          "baselineValue": 1.0, "comparison": "ok" }
      ],
      "variantResults": [
        { "variantId": "altered-number-1", "blocked": true, "caughtBy": "deterministic",
          "expectedCaughtBy": "deterministic", "pass": true }
      ],
      "groundedClaimShortfalls": []
    }
  ],
  "keylessMode": false,
  "notes": ["comparison skipped: no baseline for fixture-set version <hash>"]
}
```

Rules: every manifest case (or `--case` subset) has an entry — `failed` with `failure` cause, never
missing (SC-002); `verdict` derivation follows data-model.md §Cross-entity invariants; `keylessMode`
reports carry `"keylessMode": true` and the summary states "deterministic stages only" (US5 scenario 2).
