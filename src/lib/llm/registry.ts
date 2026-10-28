import type { z } from "zod";

/**
 * LLM task registry (extracted from router.ts so the transport layer can read
 * task definitions without a module cycle — router.ts re-exports everything).
 */

export type TaskTier = "economy" | "premium";

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type TaskDefinition<P = unknown, O = unknown> = {
  name: string;
  tier: TaskTier;
  outputSchema: z.ZodType<O>;
  inputSchema?: z.ZodType<P>;
  buildPrompt: (payload: P) => ChatMessage[];
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const registry = new Map<string, TaskDefinition<any, any>>();

export function registerTask(def: TaskDefinition) {
  registry.set(def.name, def);
}

export function resetTaskRegistry() {
  registry.clear();
}

export function getTaskDefinition(
  task: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): TaskDefinition<any, any> | null {
  return registry.get(task) ?? null;
}

export function registeredTaskTier(task: string): TaskTier | null {
  return registry.get(task)?.tier ?? null;
}
