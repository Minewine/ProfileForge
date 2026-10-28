# Transcripts

Pinned AI responses for keyless benchmark runs (`npm run benchmark -- --keyless`).

- Layout: `<fixtureSetVersion>/<taskId>.jsonl` — one JSON object per line:
  `{ inputHash, model, response, usage }`.
- `inputHash` = sha256 over (task payload, expected model); replay serves the
  pinned response for an exact hash match and fails with `TRANSCRIPT_MISS`
  otherwise — it never synthesizes.
- Produce transcripts with `npm run benchmark -- --record` (a live run that also
  records). Replay requires the same model mapping as the recording run.
- Transcripts are committed: they pin expected model behavior for the
  deterministic stages at a known fixture-set version.
