import type { LlmProvider } from "../llm/provider.js";
import type { RuntimeConfig, TaskFailure, TaskPlan, TaskState, StepResult, ValidationResult } from "../types.js";
import { collectProjectContext } from "../project/context.js";
import { generateCodeActionPlan, applyFileActions, createFileActionsPatch, validateCodeActionPlan, generateEnvironmentFix, type CodeActionPlan } from "./actions.js";
import { runValidationCommand } from "../tools/run-command.js";
import { isLongRunningCommand, isLongRunningCommandForProject } from "../tools/background-command.js";
import { requiresInstallConfirmation } from "../safety/command-policy.js";
import type { TaskStore } from "../state/task-store.js";
import { buildStepResult, summarizeStepResult } from "./context-mgr.js";
import { buildProjectProfile, classifyEnvironmentFailures, shouldAttemptEnvironmentFix } from "../project/profile.js";

export type ExecutorEvent =
  | { kind: "plan_generated"; plan: TaskPlan }
  | { kind: "step_started"; stepIndex: number; stepId: string; stepTitle: string; totalSteps: number }
  | { kind: "step_progress"; stepIndex: number; message: string }
  | { kind: "step_code_plan"; stepIndex: number; summary: string }
  | { kind: "step_patch"; stepIndex: number; patchName: string; patch: string; files: string[] }
  | { kind: "step_files_written"; stepIndex: number; files: string[] }
  | { kind: "step_verification"; stepIndex: number; results: ValidationResult[] }
  | { kind: "step_repair"; stepIndex: number; attempt: number; maxAttempts: number }
  | { kind: "step_environment_issue"; stepIndex: number; message: string }
  | { kind: "step_command_deferred"; stepIndex: number; command: string; reason: string }
  | { kind: "step_completed"; stepIndex: number; result: StepResult }
  | { kind: "milestone"; stepIndex: number; result: StepResult; progress: string }
  | { kind: "paused"; reason: string; state: TaskState }
  | { kind: "completed"; state: TaskState }
  | { kind: "failed"; state: TaskState; error: string };

export async function* executeTask(params: {
  root: string;
  config: RuntimeConfig;
  provider: LlmProvider;
  plan: TaskPlan;
  state: TaskState;
  store: TaskStore;
  patchArtifactDir?: string;
}): AsyncGenerator<ExecutorEvent> {
  const { root, config, provider, plan, state, store, patchArtifactDir } = params;
  const initialContext = await collectProjectContext(root, config, plan.goal);
  const projectProfile = initialContext.profile ?? buildProjectProfile(initialContext.fileTree);

  state.status = "running";
  await store.writeState(state);

  for (let i = state.currentStepIndex; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    state.currentStepIndex = i;

    // Check dependencies
    if (step.dependsOn?.length) {
      const incomplete = step.dependsOn.filter((depId) => {
        const depStep = plan.steps.find((s) => s.id === depId);
        if (!depStep) return false;
        const depIndex = plan.steps.indexOf(depStep);
        const completed = state.completedSteps.find((s) => s.stepId === depId);
        return !completed || completed.verificationResult === "failed";
      });
      if (incomplete.length > 0) {
        await pauseTask(store, state, {
          stepId: step.id,
          stepIndex: i,
          summary: `Cannot start step ${step.id}: dependencies not complete: ${incomplete.join(", ")}`,
          details: [`Incomplete dependencies: ${incomplete.join(", ")}`],
          suggestions: ["Resume after the dependency steps have completed successfully."],
          nextAction: "Resume this task after completing the dependency steps."
        });
        yield { kind: "paused", reason: state.blockedReason ?? "Task paused.", state };
        return;
      }
    }

    yield { kind: "step_started", stepIndex: i, stepId: step.id, stepTitle: step.title, totalSteps: plan.steps.length };

    // Build context for this step
    yield { kind: "step_progress", stepIndex: i, message: "Collecting context..." };
    const context = await collectProjectContext(root, config, step.description);
    const activeProfile = context.profile ?? projectProfile;

    const commandOnlyActionPlan = buildCommandOnlyActionPlan(step, plan.goal);
    let actionPlan: CodeActionPlan;
    if (commandOnlyActionPlan) {
      actionPlan = commandOnlyActionPlan;
    } else {
      // Generate code actions only for implementation steps. Operational verification
      // steps must not rewrite the project just to run build/test/curl commands.
      yield { kind: "step_progress", stepIndex: i, message: "Generating code..." };
      try {
        actionPlan = await generateCodeActionPlan({
          provider,
          model: config.model,
          task: `Step [${step.id}] ${step.title}: ${step.description}\n\nVerification: ${step.verification}\n\nGoal: ${plan.goal}`,
          context,
          onProgress: () => {
            // progress is tracked via events, no-op for inline updates
          }
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state.status = "failed";
        state.knownFailures.push(`Step ${step.id} plan generation failed: ${message}`);
        await store.writeState(state);
        yield { kind: "failed", state, error: `Failed to generate code plan for step ${step.id}: ${message}` };
        return;
      }
    }

    yield { kind: "step_code_plan", stepIndex: i, summary: actionPlan.summary };

    const errors = validateCodeActionPlan(root, actionPlan, { requireFiles: !commandOnlyActionPlan });
    if (errors.length > 0) {
      state.status = "failed";
      state.knownFailures.push(`Step ${step.id} validation failed: ${errors.join("; ")}`);
      await store.writeState(state);
      yield { kind: "failed", state, error: `Code action validation failed for step ${step.id}: ${errors.join("\n")}` };
      return;
    }

    // Write files
    const filesChanged: string[] = [];
    if (actionPlan.files.length > 0) {
      const patchName = `step-${i + 1}-${step.id}.diff`;
      const patchPreview = await createFileActionsPatch(root, actionPlan.files);
      if (patchPreview.patch.trim()) {
        yield { kind: "step_patch", stepIndex: i, patchName, patch: patchPreview.patch, files: patchPreview.filesChanged };
      }
      await applyFileActions(root, actionPlan.files, {
        artifactDir: patchArtifactDir,
        patchName
      });
      filesChanged.push(...actionPlan.files.map((f) => f.path));
      yield { kind: "step_files_written", stepIndex: i, files: filesChanged };
    }

    // Run verification commands
    const validationResults: ValidationResult[] = [];
    let environmentIssue = false;

    for (const cmd of actionPlan.commands) {
      if (isLongRunningCommandForProject(cmd.command, activeProfile) || requiresInstallConfirmation(cmd.command)) {
        const reason = isLongRunningCommandForProject(cmd.command, activeProfile)
          ? "Long-running commands require caller confirmation and background handling."
          : "Install commands require caller confirmation before continuing.";
        yield { kind: "step_command_deferred", stepIndex: i, command: cmd.command, reason };
        await pauseTask(store, state, {
          stepId: step.id,
          stepIndex: i,
          command: cmd.command,
          summary: `Step ${step.id} requires confirmation before running "${cmd.command}".`,
          details: [reason],
          suggestions: [`Run or approve "${cmd.command}", then resume the task.`],
          nextAction: `Confirm and run "${cmd.command}", then resume from step ${i + 1}.`
        });
        yield { kind: "paused", reason: state.blockedReason ?? "Task paused for command confirmation.", state };
        return;
      }
      const result = await runValidationCommand(root, cmd.command);

      const envIssue = classifyEnvironmentFailures([result], activeProfile);
      if (envIssue) {
        yield { kind: "step_environment_issue", stepIndex: i, message: envIssue.summary };

        if (shouldAttemptEnvironmentFix(envIssue)) {
          // Try to fix the environment issue
          const fixContext = await collectProjectContext(root, config, result.command);
          const fix = await generateEnvironmentFix({
            provider,
            model: config.model,
            issue: envIssue,
            context: fixContext,
            failedCommand: result.command
          });

          if (fix && (fix.files.length > 0 || fix.commands.length > 0)) {
            if (fix.files.length > 0) {
              const patchName = `step-${i + 1}-${step.id}-environment-fix.diff`;
              const patchPreview = await createFileActionsPatch(root, fix.files);
              if (patchPreview.patch.trim()) {
                yield { kind: "step_patch", stepIndex: i, patchName, patch: patchPreview.patch, files: patchPreview.filesChanged };
              }
              await applyFileActions(root, fix.files, {
                artifactDir: patchArtifactDir,
                patchName
              });
              for (const f of fix.files) {
                if (f.path.endsWith("gradlew") || f.path.endsWith("mvnw")) {
                  try { await runValidationCommand(root, `chmod +x ${f.path}`); } catch { /* ok */ }
                }
                if (!filesChanged.includes(f.path)) filesChanged.push(f.path);
              }
            }
            for (const cmd of fix.commands) {
              try { await runValidationCommand(root, cmd.command); } catch { /* ok */ }
            }

            // Retry the failed command
            const retryResult = await runValidationCommand(root, result.command);
            if (retryResult.exitCode === 0) {
              validationResults.push(retryResult);
              continue; // Success — continue to next command
            }
            validationResults.push(retryResult);
          }
        }

        if (!validationResults.includes(result)) {
          validationResults.push(result);
        }
        environmentIssue = true;
        await blockTaskForEnvironmentIssue(store, state, step.id, i, result, envIssue);
        break;
      }

      validationResults.push(result);
    }

    yield { kind: "step_verification", stepIndex: i, results: validationResults };

    if (environmentIssue) {
      yield { kind: "paused", reason: state.blockedReason ?? "Task blocked by environment issue.", state };
      return;
    }

    // Repair loop for failed validations
    const failedResults = validationResults.filter((r) => r.exitCode !== 0);
    if (failedResults.length > 0 && !environmentIssue) {
      for (let attempt = 0; attempt < config.maxRepairAttempts && failedResults.length > 0; attempt++) {
        yield { kind: "step_repair", stepIndex: i, attempt: attempt + 1, maxAttempts: config.maxRepairAttempts };

        const repairContext = await collectProjectContext(root, config, step.description);
        const errorSummary = failedResults
          .map((r) => `$ ${r.command}\nexitCode: ${r.exitCode}\n${r.stderr || r.stdout}`)
          .join("\n\n");

        let repairPlan;
        try {
          repairPlan = await generateCodeActionPlan({
            provider,
            model: config.model,
            task: `Fix validation errors from step [${step.id}] ${step.title}.\nOriginal task: ${step.description}\n\nCommand errors:\n${errorSummary}`,
            context: repairContext,
            onProgress: () => {}
          });
        } catch {
          break;
        }

        const repairErrors = validateCodeActionPlan(root, repairPlan, { requireFiles: true });
        if (repairErrors.length > 0) break;

        if (repairPlan.files.length > 0) {
          const patchName = `step-${i + 1}-${step.id}-repair-${attempt + 1}.diff`;
          const patchPreview = await createFileActionsPatch(root, repairPlan.files);
          if (patchPreview.patch.trim()) {
            yield { kind: "step_patch", stepIndex: i, patchName, patch: patchPreview.patch, files: patchPreview.filesChanged };
          }
          await applyFileActions(root, repairPlan.files, {
            artifactDir: patchArtifactDir,
            patchName
          });
          for (const f of repairPlan.files) {
            if (!filesChanged.includes(f.path)) filesChanged.push(f.path);
          }
        }

        const newResults: ValidationResult[] = [];
        for (const cmd of repairPlan.commands) {
          if (!isLongRunningCommandForProject(cmd.command, activeProfile) && !requiresInstallConfirmation(cmd.command)) {
            const result = await runValidationCommand(root, cmd.command);
            newResults.push(result);
          }
        }

        failedResults.length = 0;
        failedResults.push(...newResults.filter((r) => r.exitCode !== 0));
      }
    }

    // Build step result
    const verificationResult = validationResults.length === 0 ? "skipped"
      : failedResults.length === 0 ? "passed"
      : "failed";

    const summary = await summarizeStepResult(provider, config.model, step, {
      filesChanged,
      verificationResult,
      errors: failedResults.map((r) => r.stderr || r.stdout)
    });

    const stepResult = buildStepResult(step, filesChanged, verificationResult, summary);
    state.completedSteps.push(stepResult);

    if (verificationResult === "failed") {
      await pauseTask(store, state, {
        stepId: step.id,
        stepIndex: i,
        command: failedResults[0]?.command,
        exitCode: failedResults[0]?.exitCode,
        stdout: failedResults[0]?.stdout,
        stderr: failedResults[0]?.stderr,
        summary: `Step ${step.id} verification failed after ${config.maxRepairAttempts} repair attempt(s).`,
        details: failedResults.map((r) => `${r.command} exited ${r.exitCode}`),
        suggestions: ["Inspect the command output, adjust the code or environment, then resume the task."],
        nextAction: `Fix the failure for step ${i + 1}, then resume this task.`
      }, "failed");
    }

    state.updatedAt = new Date().toISOString();
    await store.writeState(state);
    await store.writeStepResult(i, stepResult);

    yield { kind: "step_completed", stepIndex: i, result: stepResult };

    if (verificationResult === "failed") {
      yield { kind: "failed", state, error: state.blockedReason ?? `Step ${step.id} verification failed.` };
      return;
    }

    // Milestone pause
    if (step.milestone === true && i < plan.steps.length - 1) {
      const progress = buildProgressSummary(plan, state);
      yield { kind: "milestone", stepIndex: i, result: stepResult, progress };
      state.status = "paused";
      state.currentStepIndex = i;
      state.blockedReason = `Milestone reached after step ${step.id}.`;
      state.lastFailure = undefined;
      state.updatedAt = new Date().toISOString();
      await store.writeState(state);
      return; // caller must resume with updated currentStepIndex
    }
  }

  state.status = "completed";
  state.updatedAt = new Date().toISOString();
  await store.writeState(state);
  yield { kind: "completed", state };
}

export function resolveResumeStepIndex(plan: TaskPlan, state: TaskState): number {
  const currentStep = plan.steps[state.currentStepIndex];
  if (!currentStep) return Math.min(state.currentStepIndex, Math.max(plan.steps.length - 1, 0));

  const currentCompleted = state.completedSteps.some((result) => result.stepId === currentStep.id && result.verificationResult !== "failed");
  if (!currentCompleted) return state.currentStepIndex;

  let nextIndex = state.currentStepIndex + 1;
  while (nextIndex < plan.steps.length) {
    const step = plan.steps[nextIndex];
    if (!step) break;
    const completed = state.completedSteps.some((result) => result.stepId === step.id && result.verificationResult !== "failed");
    if (!completed) break;
    nextIndex += 1;
  }
  return Math.min(nextIndex, plan.steps.length);
}

function buildCommandOnlyActionPlan(step: TaskPlan["steps"][number], goal: string): CodeActionPlan | undefined {
  const verification = step.verification.trim();
  if (!verification) return undefined;
  if (step.expectedFiles.length > 0 && !isOperationalGoal(goal)) return undefined;

  return {
    summary: `Run verification command for step ${step.id}: ${step.title}`,
    files: [],
    commands: [{
      command: verification,
      reason: step.description || step.title
    }]
  };
}

function isOperationalGoal(goal: string): boolean {
  const normalized = goal.toLowerCase();
  const implementationKeywords = [
    "验证码",
    "增加",
    "添加",
    "修改",
    "实现",
    "接口",
    "注册",
    "登录",
    "找回密码",
    "email",
    "邮箱",
    "邮件",
    "password",
    "endpoint",
    "api"
  ];
  if (implementationKeywords.some((keyword) => normalized.includes(keyword))) return false;

  return [
    "启动服务",
    "运行服务",
    "完成测试",
    "测试链路",
    "运行并测试",
    "启动并测试",
    "修复后验证",
    "验证",
    "run and test",
    "start service",
    "start the service",
    "run the service",
    "verify",
    "validate",
    "e2e",
    "end-to-end"
  ].some((keyword) => normalized.includes(keyword));
}

async function pauseTask(
  store: TaskStore,
  state: TaskState,
  failure: Omit<TaskFailure, "occurredAt">,
  status: "paused" | "blocked" | "failed" = "paused"
): Promise<void> {
  const lastFailure: TaskFailure = {
    ...failure,
    occurredAt: new Date().toISOString()
  };
  state.status = status;
  state.currentStepIndex = failure.stepIndex;
  state.blockedReason = failure.summary;
  state.lastFailure = lastFailure;
  state.knownFailures.push(failure.summary);
  state.updatedAt = lastFailure.occurredAt;
  await store.writeState(state);
}

async function blockTaskForEnvironmentIssue(
  store: TaskStore,
  state: TaskState,
  stepId: string,
  stepIndex: number,
  result: ValidationResult,
  issue: { summary: string; details: string[]; suggestions: string[] }
): Promise<void> {
  await pauseTask(store, state, {
    stepId,
    stepIndex,
    command: result.command,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    summary: issue.summary,
    details: issue.details,
    suggestions: issue.suggestions,
    nextAction: `Resolve the environment issue for "${result.command}", then resume this task.`
  }, "blocked");
}

function buildProgressSummary(plan: TaskPlan, state: TaskState): string {
  const total = plan.steps.length;
  const done = state.completedSteps.filter((s) => s.verificationResult === "passed").length;
  const lines: string[] = [`Progress: ${done}/${total} steps passed`];

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const result = state.completedSteps.find((s) => s.stepId === step.id);
    const status = result
      ? result.verificationResult === "passed" ? "✅"
        : result.verificationResult === "failed" ? "❌"
        : "⏭️"
      : i === state.currentStepIndex ? "🔄"
      : "⏳";
    const warnings = result?.semanticWarnings?.length ? ` ⚠️${result.semanticWarnings.length}` : "";
    lines.push(`  ${status} [${step.id}] ${step.title}${warnings}`);
  }

  return lines.join("\n");
}
