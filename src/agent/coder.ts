import type { LlmProvider } from "../llm/provider.js";
import type { ProjectContext } from "../types.js";
import { patchPrompt } from "./prompts.js";

export async function generatePatch(provider: LlmProvider, task: string, plan: string, context: ProjectContext, model: string): Promise<string> {
  const prompt = patchPrompt(task, plan, context);
  return provider.generateText({ ...prompt, model });
}
