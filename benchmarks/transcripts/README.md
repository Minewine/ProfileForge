# Transcripts

Pinned AI responses for keyless benchmark runs (`npm run benchmark -- --keyless`).

- Layout: `<fixtureSetVersion>/<caseId>/<taskId>.jsonl` — one JSON object per
  line: `{ inputHash, model, response, usage }`. Files are scoped per fixture
  case so cases sharing a JD never serve each other's pins.
- `inputHash` = sha256 over (canonicalized task payload, expected model): id
  references that embed per-run database ids (plan claim keys, the
  semantic-proposals digest ids, and the responses' back-references) are
  canonicalized to positional `#i` before hashing and materialized back onto
  the current run's ids at replay — replay is deterministic across runs even
  though the database is reset each time.
- The LAST matching entry in a file wins: `--record` appends, so a later
  recording of the same input supersedes earlier ones.
- Produce transcripts with `npm run benchmark -- --record` (a live run that also
  records). Replay requires the same model mapping as the recording run.
- Transcripts are committed: they pin expected model behavior for the
  deterministic stages at a known fixture-set version.
