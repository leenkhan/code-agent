import type { LlmProvider } from "../llm/provider.js";
import type { ProjectContext, ValidationResult } from "../types.js";
import { repairPrompt } from "./prompts.js";

export async function generateRepairPatch(provider: LlmProvider, task: string, context: ProjectContext, validation: ValidationResult[], currentDiff: string, model: string): Promise<string> {
  const prompt = repairPrompt(task, context, validation, currentDiff);
  return provider.generateText({ ...prompt, model });
}
