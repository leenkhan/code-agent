import { resolveRuntimeConfig } from "../state/config.js";
import { executePlanOnly } from "../agent/runtime.js";
import { createLlmProvider } from "../llm/factory.js";

export async function planCommand(root: string, task: string, options: { model?: string }): Promise<void> {
  const config = await resolveRuntimeConfig(root, { model: options.model });
  await executePlanOnly({ root, task, config, provider: createLlmProvider(config) });
}
