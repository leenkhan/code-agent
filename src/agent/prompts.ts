import type { ProjectContext, ValidationResult } from "../types.js";
import { renderContext } from "../utils/llm.js";

export function plannerPrompt(task: string, context: ProjectContext): { system: string; prompt: string } {
  return {
    system: "You are a careful local CLI code agent planner. Produce concise implementation plans only.",
    prompt: `Task:\n${task}\n\nProject context:\n${renderContext(context)}\n\nReturn a plan with:\n- Understanding of the request\n- Files likely to be changed\n- Implementation steps\n- Validation strategy\n- Risks or assumptions`
  };
}

export function patchPrompt(task: string, plan: string, context: ProjectContext): { system: string; prompt: string } {
  return {
    system: "You are modifying a local codebase. Return only a valid unified diff.",
    prompt: `You are modifying a local codebase.
Return only a valid unified diff.
Do not include explanations.
Do not include markdown fences.
Do not modify unrelated files.
Do not delete user code unless necessary.
Prefer the smallest working change.
If context is insufficient, return a clear message beginning with NEED_MORE_CONTEXT:

Task:
${task}

Plan:
${plan}

Project context:
${renderContext(context)}`
  };
}

export function repairPrompt(task: string, context: ProjectContext, validation: ValidationResult[], currentDiff: string): { system: string; prompt: string } {
  return {
    system: "You repair failed local code changes. Return only a valid unified diff.",
    prompt: `You are repairing a failed change.
Return only a valid unified diff.
Do not include explanations.
Do not include markdown fences.
Prefer the smallest working repair.
If context is insufficient, return a clear message beginning with NEED_MORE_CONTEXT:

Task:
${task}

Current git diff:
${currentDiff}

Validation results:
${JSON.stringify(validation, null, 2)}

Project context:
${renderContext(context)}`
  };
}
