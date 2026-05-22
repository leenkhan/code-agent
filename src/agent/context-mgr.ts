import type { LlmProvider } from "../llm/provider.js";
import type { ProjectContext, TaskPlan, TaskState, StepResult } from "../types.js";
import { renderContext } from "../utils/llm.js";

const MAX_COMPLETED_STEPS_IN_CONTEXT = 10;
const MIN_SUMMARY_LENGTH = 20;
const MAX_SUMMARY_LENGTH = 200;

export function compressCompletedSteps(state: TaskState): string {
  if (state.completedSteps.length === 0) return "(no steps completed yet)";

  const recent = state.completedSteps.slice(-MAX_COMPLETED_STEPS_IN_CONTEXT);
  const older = state.completedSteps.slice(0, -MAX_COMPLETED_STEPS_IN_CONTEXT);

  const lines: string[] = [];

  if (older.length > 0) {
    const fileCount = older.reduce((sum, s) => sum + s.filesChanged.length, 0);
    lines.push(`Earlier (${older.length} steps, ${fileCount} files):`);
    for (const step of older) {
      lines.push(`  [${step.stepId}] ${step.title} — ${truncate(step.summary, 80)} (${step.verificationResult})`);
    }
  }

  if (recent.length > 0) {
    if (older.length > 0) lines.push("");
    lines.push(`Recent (${recent.length} steps):`);
    for (const step of recent) {
      const warnings = step.semanticWarnings?.length ? ` ⚠️ ${step.semanticWarnings.length} semantic warnings` : "";
      lines.push(`  [${step.stepId}] ${step.title} — ${step.summary} (${step.verificationResult})${warnings}`);
      if (step.filesChanged.length > 0) {
        lines.push(`    Files: ${step.filesChanged.join(", ")}`);
      }
    }
  }

  return lines.join("\n");
}

export function buildStepContext(params: {
  plan: TaskPlan;
  state: TaskState;
  stepIndex: number;
  context: ProjectContext;
}): string {
  const { plan, state, stepIndex, context } = params;
  const step = plan.steps[stepIndex];
  if (!step) return "";

  const parts: string[] = [];

  parts.push(`## Goal\n${plan.goal}`);

  const completedSummary = compressCompletedSteps(state);
  parts.push(`\n## Completed Steps\n${completedSummary}`);

  parts.push(`\n## Current Step [${step.id}] ${step.title}`);
  parts.push(`Description: ${step.description}`);
  if (step.expectedFiles.length > 0) {
    parts.push(`Expected files: ${step.expectedFiles.join(", ")}`);
  }
  parts.push(`Verification: ${step.verification || "(run build or typecheck)"}`);

  if (state.knownFailures.length > 0) {
    parts.push(`\n## Known Failures\n${state.knownFailures.slice(-5).join("\n")}`);
  }

  parts.push(`\n## Project State\n${renderContext(context)}`);

  return parts.join("\n");
}

export async function summarizeStepResult(
  provider: LlmProvider,
  model: string,
  step: { id: string; title: string; description: string },
  result: { filesChanged: string[]; verificationResult: string; errors?: string[] }
): Promise<string> {
  const prompt = `Summarize the result of this completed development step in one concise line (under 150 chars).

Step: [${step.id}] ${step.title}
Description: ${step.description}
Files changed: ${result.filesChanged.join(", ") || "none"}
Verification: ${result.verificationResult}
${result.errors?.length ? `Errors encountered: ${result.errors.join(", ")}` : ""}

Return only the summary line, no other text.`;

  try {
    const response = await provider.generateText({
      model,
      system: "You summarize completed coding task steps. Return only the summary text, no JSON, no markdown.",
      prompt
    });
    return truncate(response.trim(), MAX_SUMMARY_LENGTH);
  } catch {
    return buildFallbackSummary(step, result);
  }
}

export function buildFallbackSummary(
  step: { id: string; title: string },
  result: { filesChanged: string[]; verificationResult: string }
): string {
  const files = result.filesChanged.length > 0
    ? `Created/modified ${result.filesChanged.join(", ")}`
    : "No files changed";
  return `[${step.id}] ${step.title}: ${files}. Verification: ${result.verificationResult}.`;
}

export function buildStepResult(
  step: { id: string; title: string },
  filesChanged: string[],
  verificationResult: "passed" | "failed" | "skipped",
  summary: string,
  semanticWarnings?: string[]
): StepResult {
  return {
    stepId: step.id,
    title: step.title,
    summary: truncate(summary || buildFallbackSummary(step, { filesChanged, verificationResult }), MAX_SUMMARY_LENGTH),
    filesChanged,
    verificationResult,
    semanticWarnings
  };
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 3) + "...";
}
