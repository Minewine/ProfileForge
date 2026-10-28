# LLM Router Contract (callLLM)

Single choke point for every OpenRouter call (FR-008). Implementation: `src/lib/llm/router.ts`.

## Signature

```ts
callLLM<T>(args: {
  task: "parseCV" | "extractRequirements" | "generateMatchReport" | "generateTailoredCV" | "generateCoverLetter" | "factGuard"  // slice 1 implements parseCV; others throw TASK_NOT_IMPLEMENTED
  payload: unknown                      // zod-validated per task before send
  runId?: string                        // groups a user-run for cost capping; defaults to a fresh run (single call)
}): Promise<{ data: T; usage: { promptTokens, completionTokens, costUsd }, modelUsed: string }>
```

## Behavior (binding rules)

1. **Key resolution**: `OPENROUTER_API_KEY` env → encrypted `AppSettings` value. Missing key ⇒ `LLM_KEY_INVALID` error before any network call.
2. **Model selection**: task → tier (`parseCV`/`extractRequirements`/`factGuard` → economy; `generateTailoredCV`/`generateCoverLetter` → premium) → id from settings; overridable via `args.model`.
3. **Structured output**: for models advertising `structured_outputs` support, the request carries `response_format: { type: "json_schema", strict: true, json_schema: { name: task, schema } }` and `provider: { require_parameters: true }`. For models without that support (e.g. free-tier picks such as `minimax/minimax-m3.1-flash:free`, the decided economy default), the router degrades to prompt-only mode: `response_format`/`provider` are omitted and the JSON schema is appended to the prompt — local enforcement (rule 4) still guarantees the contract.
4. **Local enforcement**: response parsed and zod-validated regardless of provider guarantees. On validation failure: up to **2 repair retries** (same request + validation errors appended as a repair instruction); exhausted ⇒ `LLM_SCHEMA_REPAIR_FAILED`.
5. **Payload minimization** (FR-009): send only the text the task needs — `parseCV` receives extracted text (with page markers), never the whole file bytes; settings/profile metadata are not included.
6. **Usage & cap**: after each call, persist `LlmUsageLog` (task, model, runId, tokens, `usage.cost`, duration). Before each call, the run's accumulated cost is checked against `costCapUsd` (default 0.50): reached ⇒ `COST_CAP_REACHED` (actionable: raise cap in settings). Cost is shown per run in the UI (FR-008).
7. **Timeout**: 120 s per attempt, then retry once on timeout ⇒ `LLM_UNAVAILABLE`.

## Error taxonomy (mapped, actionable — FR-025)

| OpenRouter condition | Code | User-facing message includes |
|----------------------|------|------------------------------|
| 401/403 | `LLM_KEY_INVALID` | "check the key in Settings" |
| 402 / insufficient credits | `LLM_QUOTA` | "top up OpenRouter credit or check the key's spend limit" |
| 429 | `LLM_RATE_LIMITED` | "wait a moment and retry" (auto-retry once with backoff) |
| 5xx / network / timeout | `LLM_UNAVAILABLE` | "provider temporarily unavailable — retry" |
| schema repair exhausted | `LLM_SCHEMA_REPAIR_FAILED` | "the model returned unusable output; retry or switch model in Settings" |

No error path ever substitutes fabricated content; partial work completed before the failure is preserved (slice 1: the uploaded document and extracted text remain usable).

## Task registry

Each task declares: zod input schema, zod output schema, tier, prompt template, and (where applicable) deterministic post-passes (parseCV: date normalization + containment check — see parsecv-task.md). Adding a later-slice task = adding one registry entry; router internals do not change.
