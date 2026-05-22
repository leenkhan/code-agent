import type { LlmProvider } from "../llm/provider.js";
import type { ProjectContext } from "../types.js";
import { plannerPrompt } from "./prompts.js";

export async function generatePlan(provider: LlmProvider, task: string, context: ProjectContext, model: string): Promise<string> {
  const prompt = plannerPrompt(task, context);
  return provider.generateText({ ...prompt, model });
}
