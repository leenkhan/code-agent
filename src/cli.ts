#!/usr/bin/env node
import { Command } from "commander";
import { findProjectRoot } from "./project/root.js";
import { logger } from "./ui/logger.js";
import { initCommand } from "./commands/init.js";
import { doctorCommand } from "./commands/doctor.js";
import { planCommand } from "./commands/plan.js";
import { fixCommand } from "./commands/fix.js";
import { diffCommand } from "./commands/diff.js";
import { revertCommand } from "./commands/revert.js";
import { chatCommand } from "./commands/chat.js";

async function main(): Promise<void> {
  const program = new Command();
  program
    .name("codeshit")
    .description("CodeShit — local-first coding agent for messy codebases")
    .version("0.3.1-beta.0")
    .option("--model <model>", "model for interactive chat");

  program.action(async (options: { model?: string }) => {
    await chatCommand(await findProjectRoot(), options);
  });

  program.command("init").description("Create global and project CodeShit config").action(async () => {
    await initCommand(await findProjectRoot());
  });

  program.command("doctor").description("Print detected project and configuration information").action(async () => {
    await doctorCommand(await findProjectRoot());
  });

  program.command("plan").argument("<task>").option("--model <model>").description("Generate and save an implementation plan").action(async (task: string, options: { model?: string }) => {
    await planCommand(await findProjectRoot(), task, options);
  });

  program.command("fix")
    .option("--auto-apply", "apply patches without confirmation")
    .option("--max-repair-attempts <number>")
    .option("--cmd <command>", "validation command", (value, previous: string[] = []) => [...previous, value], [])
    .option("--model <model>")
    .description("Run validation and repair failures")
    .action(async (options) => {
      await fixCommand(await findProjectRoot(), options);
    });

  program.command("diff").description("Print current git diff and latest run patch path").action(async () => {
    await diffCommand(await findProjectRoot());
  });

  program.command("revert").description("Revert latest applied patch").action(async () => {
    await revertCommand(await findProjectRoot());
  });

  program.command("tasks").description("List saved tasks and their status").action(async () => {
    const { listTasks } = await import("./state/task-store.js");
    const tasks = await listTasks(await findProjectRoot());
    if (tasks.length === 0) {
      logger.info("No saved tasks found.");
      return;
    }
    logger.heading("Saved tasks");
    for (const task of tasks) {
      const icon = task.status === "completed" ? "✅" : task.status === "failed" ? "❌" : task.status === "running" ? "🔄" : "⏸️";
      logger.info(`${icon} ${task.taskId}`);
      logger.info(`   Goal: ${task.goal}`);
      logger.info(`   Status: ${task.status} | Updated: ${task.updatedAt}`);
    }
  });

  program.command("resume").argument("[task-id]", "Task ID to resume").description("Resume a paused or incomplete task").action(async (taskId?: string) => {
    const root = await findProjectRoot();
    const { resolveRuntimeConfig } = await import("./state/config.js");
    const { createLlmProvider } = await import("./llm/factory.js");
    const { loadTaskStore, listTasks } = await import("./state/task-store.js");
    const { createRunStore } = await import("./state/run-store.js");
    const { executeTask } = await import("./agent/task-executor.js");

    const config = await resolveRuntimeConfig(root, {});
    const provider = createLlmProvider(config);

    let resolvedTaskId = taskId;
    if (!resolvedTaskId) {
      const tasks = await listTasks(root);
      const incomplete = tasks.filter((t) => t.status === "paused" || t.status === "blocked" || t.status === "running" || t.status === "failed");
      if (incomplete.length === 0) {
        logger.info("No paused or incomplete tasks to resume. Use 'codeshit tasks' to see all tasks.");
        return;
      }
      resolvedTaskId = incomplete[0].taskId;
    }

    const taskStore = await loadTaskStore(root, resolvedTaskId);
    if (!taskStore) {
      logger.error(`Task not found: ${resolvedTaskId}`);
      return;
    }

    const state = await taskStore.readState();
    const plan = await taskStore.readPlan();
    const { collectProjectContext } = await import("./project/context.js");
    const { normalizeTaskPlanForContext } = await import("./agent/task-planner.js");
    const context = await collectProjectContext(root, config, plan.goal);
    const normalizedPlan = normalizeTaskPlanForContext(plan, context);
    if (JSON.stringify(normalizedPlan) !== JSON.stringify(plan)) {
      await taskStore.writePlan(normalizedPlan);
    }
    if (!state) {
      logger.error(`Task state not found for: ${resolvedTaskId}`);
      return;
    }

    if (state.status === "completed") {
      logger.info(`Task ${resolvedTaskId} is already completed.`);
      return;
    }

    logger.heading(`Resuming: ${normalizedPlan.goal}`);
    const { resolveResumeStepIndex } = await import("./agent/task-executor.js");
    const resumeIndex = resolveResumeStepIndex(normalizedPlan, state);
    if (state.lastFailure) {
      logger.warn(`Last stop: ${state.lastFailure.summary}`);
      logger.info(`Next action: ${state.lastFailure.nextAction}`);
    }
    const totalSteps = normalizedPlan.steps.length;
    const runStore = await createRunStore(root, `resume ${resolvedTaskId}`);
    const generator = executeTask({
      root,
      config: { ...config, autoApply: true },
      provider,
      plan: normalizedPlan,
      state: { ...state, currentStepIndex: resumeIndex, status: "running" },
      store: taskStore,
      patchArtifactDir: runStore.dir
    });

    for await (const event of generator) {
      switch (event.kind) {
        case "step_started":
          logger.heading(`[${event.stepId}/${totalSteps}] ${event.stepTitle}`);
          break;
        case "step_files_written":
          logger.success(`Files: ${event.files.join(", ")}`);
          break;
        case "step_patch":
          logger.heading(`Patch: ${event.patchName}`);
          logger.info(event.patch);
          break;
        case "step_repair":
          logger.warn(`Repair attempt ${event.attempt}/${event.maxAttempts}...`);
          break;
        case "step_command_deferred":
          logger.warn(`Command requires confirmation: ${event.command}`);
          logger.info(event.reason);
          break;
        case "step_environment_issue":
          logger.warn(`Environment issue: ${event.message}`);
          break;
        case "step_completed": {
          const icon = event.result.verificationResult === "passed" ? "✅" : event.result.verificationResult === "failed" ? "❌" : "⏭️";
          logger.info(`${icon} Step complete: ${event.result.summary}`);
          break;
        }
        case "milestone":
          logger.heading("Milestone reached — auto-continuing...");
          // In CLI mode, auto-continue past milestones by recursing
          const updatedState = await taskStore.readState();
          if (!updatedState) break;
          const nextGen = executeTask({
            root,
            config: { ...config, autoApply: true },
            provider,
            plan: normalizedPlan,
            state: { ...updatedState, currentStepIndex: resolveResumeStepIndex(normalizedPlan, updatedState), status: "running" },
            store: taskStore,
            patchArtifactDir: runStore.dir
          });
          for await (const ev of nextGen) {
            if (ev.kind === "step_started") logger.heading(`[${ev.stepId}/${totalSteps}] ${ev.stepTitle}`);
            else if (ev.kind === "step_files_written") logger.success(`Files: ${ev.files.join(", ")}`);
            else if (ev.kind === "step_patch") {
              logger.heading(`Patch: ${ev.patchName}`);
              logger.info(ev.patch);
            }
            else if (ev.kind === "step_repair") logger.warn(`Repair attempt ${ev.attempt}/${ev.maxAttempts}...`);
            else if (ev.kind === "step_command_deferred") {
              logger.warn(`Command requires confirmation: ${ev.command}`);
              logger.info(ev.reason);
            }
            else if (ev.kind === "step_environment_issue") logger.warn(`Environment issue: ${ev.message}`);
            else if (ev.kind === "step_completed") {
              const ic = ev.result.verificationResult === "passed" ? "✅" : ev.result.verificationResult === "failed" ? "❌" : "⏭️";
              logger.info(`${ic} Step complete: ${ev.result.summary}`);
            } else if (ev.kind === "milestone") logger.info("Milestone — auto-continuing...");
            else if (ev.kind === "completed") logger.success("Task completed.");
            else if (ev.kind === "failed") logger.error(`Task failed: ${ev.error}`);
          }
          return;
        case "completed":
          logger.success("Task completed.");
          return;
        case "failed":
          logger.error(`Task failed: ${event.error}`);
          return;
        case "paused":
          logger.warn(`Task paused: ${event.reason}`);
          if (event.state.lastFailure) {
            if (event.state.lastFailure.details.length > 0) {
              logger.info(event.state.lastFailure.details.map((detail) => `- ${detail}`).join("\n"));
            }
            if (event.state.lastFailure.suggestions.length > 0) {
              logger.info("Suggested next steps:");
              logger.info(event.state.lastFailure.suggestions.map((suggestion) => `- ${suggestion}`).join("\n"));
            }
            logger.info(`Next action: ${event.state.lastFailure.nextAction}`);
          }
          return;
      }
    }
  });

  program.command("chat")
    .option("--auto-apply", "write inferred file actions without confirmation")
    .option("--no-test", "skip validation commands for inferred code changes")
    .option("--max-repair-attempts <number>")
    .option("--cmd <command>", "validation command for inferred code changes", (value, previous: string[] = []) => [...previous, value], [])
    .option("--model <model>")
    .description("Start an interactive terminal conversation")
    .action(async (options) => {
      await chatCommand(await findProjectRoot(), options);
    });

  await program.parseAsync(process.argv);
}

main().catch((error: unknown) => {
  logger.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
