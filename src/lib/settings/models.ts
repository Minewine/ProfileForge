export type ModelInfo = { id: string; name?: string; structuredOutputs: boolean };

type ModelEntry = { id: string; name?: string; supported_parameters?: string[] };

let cache: { at: number; models: ModelInfo[] } | null = null;
const TTL_MS = 5 * 60 * 1000;

async function fetchModels(): Promise<ModelInfo[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.models;
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models", {
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return cache?.models ?? [];
    const body = (await res.json()) as { data?: ModelEntry[] };
    const models = (body.data ?? []).map((m) => ({
      id: m.id,
      name: m.name,
      structuredOutputs: m.supported_parameters?.includes("structured_outputs") ?? false,
    }));
    cache = { at: Date.now(), models };
    return models;
  } catch {
    return cache?.models ?? [];
  }
}

/** Searchable model list for the Settings picker (public endpoint, no key needed). */
export async function listModels(query: string, limit = 50): Promise<ModelInfo[]> {
  const models = await fetchModels();
  const q = query.toLowerCase().trim();
  return models
    .filter((m) => !q || m.id.toLowerCase().includes(q) || (m.name ?? "").toLowerCase().includes(q))
    .sort(
      (a, b) =>
        Number(b.structuredOutputs) - Number(a.structuredOutputs) || a.id.localeCompare(b.id),
    )
    .slice(0, limit);
}

/**
 * Checks a model id against OpenRouter's model list for structured-output
 * support (`supported_parameters` includes "structured_outputs"). Cached 5 min.
 */
export async function modelSupportsStructuredOutputs(modelId: string): Promise<boolean> {
  const models = await fetchModels();
  if (models.length === 0) return true; // listing unavailable — fail open; strictness is enforced per-response
  return models.some((m) => m.id === modelId && m.structuredOutputs);
}
