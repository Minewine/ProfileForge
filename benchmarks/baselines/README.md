# Baselines

Committed benchmark baselines, one file per fixture-set version:
`<fixtureSetVersion>.json` (the fixture-set version is a content hash of
`benchmarks/fixtures/**` — editing any fixture invalidates old baselines).

**Rules:**

- Baselines are source, not artifacts: they are reviewed like code.
- Change a baseline only by running `npm run benchmark -- --update-baseline` —
  never by hand. The run must complete (`status: complete`, `partial: false`).
- Each file records `pinnedAt`, `pinnedBy` (the `--label`), `codeState`, and the
  effective model mapping, so every re-pin is auditable.
