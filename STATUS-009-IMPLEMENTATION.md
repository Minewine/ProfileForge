# STATUS — slice 009 (Evaluation Benchmark): implementation complete, one live step pending

Updated 2026-10-28, end of `$speckit-implement`. **37 of 38 tasks complete and verified**;
`specs/009-evaluation-benchmark/tasks.md` checkboxes are the source of truth.

## Final verification state (2026-10-28)

- `npm test` — **494/494 passed** (420 pre-existing + 74 new benchmark tests), incl. the full
  generation pipeline driven end-to-end on real fixtures with mocked AI
- `npm run build` — green, `npx tsc --noEmit` — **0 errors**
- `npm run lint` — **0 errors**, 7 warnings (all pre-existing, in test files)
- `npm run test:e2e` — **45 passed / 1 key-gated skip** (re-run after every edit)
- Live CLI (real OpenRouter, free model): schema reset + DB creation + migrations ✓; keyless
  loud-miss path ✓ (exit 2, `TRANSCRIPT_MISS` per case, nothing synthesized); `--record` captured
  ~90% of all transcripts across the 4 cases before rate-limiting

## The one open item — T037 (live quickstart scenarios)

**Blocked by OpenRouter's free-tier daily cap** ("free-models-per-day" exhausted; paid models
unavailable — zero credits on the account). Resume after the daily reset (or with credits):

```bash
npm run benchmark -- --record --update-baseline --label "first baseline (free models)" \
  --models extractRequirements=nvidia/nemotron-3.5-super-vl:free,semanticProposals=nvidia/nemotron-3.5-super-vl:free,generateTailoredCV=nvidia/nemotron-3.5-super-vl:free,generateCoverLetter=nvidia/nemotron-3.5-super-vl:free
npm run benchmark -- --keyless            # Scenario A — should pass, exit 0
npm run benchmark -- --keyless            # again — SC-004 reproducibility
```

(The test key the user provided works — the first `--record` attempt failed on key resolution due
to an empty `.env` value, since fixed; the *second* blocker is the daily request cap, which resets.)

## Live findings already folded back into the code

1. **Variant needles must survive translation** — live output rewrites bullet text, so substring
   targets like "temps de réponse" miss. Fixed: needles are now translation-stable numbers
   (`["p95", "35"]`). (Partial transcripts recorded under the old fixture-set version are orphans;
   re-record after the cap resets.)
2. **Report durability** — the CLI previously persisted the report *after* the
   `--update-baseline` check, so a refused pin lost the report (and its failure causes). Fixed:
   every run persists `report.json` + `summary.md` before anything can intervene.
3. `TRANSCRIPT_MISS` added to the product's error-code registry (additive).

## Notable product-code change (the only one)

`src/lib/llm/router.ts` was split: task registry → `src/lib/llm/registry.ts`, execution body
(moved verbatim) → `src/lib/llm/transport.ts` with an injectable transport. Existing suites
(`llm-router`, `generations-api`, `llm-errors`) all pass — two source-contract assertions in
`llm-errors.test.ts` were re-pointed at the new file. Everything else under `src/lib/benchmark/`
and `scripts/run-benchmark.ts` is additive.

## Docs updated

`README.md` (status line + Benchmark section), `ProfileForge-Specification.md` (Current Status:
009 Implemented; Evaluation module no longer "not started"), `CONSOLIDATION.md` (inventory row),
`benchmarks/README.md` (new). `gui-test-screenshots/` and `uploads-e2e/` are gitignored.
