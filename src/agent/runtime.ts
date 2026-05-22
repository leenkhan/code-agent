import path from "node:path";
import { askConfirm } from "../ui/confirm.js";
import { logger } from "../ui/logger.js";
import type { LlmProvider } from "../llm/provider.js";
import type { RuntimeConfig, RunResult, ValidationResult } from "../types.js";
import { collectProjectContext } from "../project/context.js";
import { detectValidationCommands } from "../project/detect.js";
import { gitDiff, gitStatus } from "../tools/git.js";
import { runValidationCommand } from "../tools/run-command.js";
import { createRunStore, saveInitialArtifacts, saveResult } from "../state/run-store.js";
import { generatePlan } from "./planner.js";
import { generatePatch } from "./coder.js";
import { generateRepairPatch } from "./repairer.js";
import { validatePatch } from "../patch/validate.js";
import { applyPatch, checkPatchApplies } from "../patch/apply.js";

export type RunOptions = {
  root: string;
  task: string;
  config: RuntimeConfig;
  provider: LlmProvider;
  noTest?: boolean;
  commands?: string[];
  planOnly?: boolean;
};

async function validationCommands(root: string, config: RuntimeConfig, explicit?: string[]): Promise<string[]> {
  if (explicit?.length) return explicit;
  if (config.validationCommands.length) return config.validationCommands;
  return detectValidationCommands(root);
}

export async function runValidation(root: string, commands: string[]): Promise<ValidationResult[]> {
  const results: ValidationResult[] = [];
  for (const command of commands) {
    logger.info(`Running: ${command}`);
    results.push(await runValidationCommand(root, command));
  }
  return results;
}

function allPassed(results: ValidationResult[]): boolean {
  return results.every((result) => result.exitCode === 0);
}

function formatValidationLog(results: ValidationResult[]): string {
  return results
    .map((result) => [
      `$ ${result.command}`,
      `exitCode: ${result.exitCode}`,
      `durationMs: ${result.durationMs}`,
      "stdout:",
      result.stdout,
      "stderr:",
      result.stderr
    ].join("\n"))
    .join("\n\n");
}

async function confirmPatch(patch: string, autoApply: boolean): Promise<boolean> {
  logger.heading("Patch");
  logger.info(patch);
  return autoApply || askConfirm("Apply this patch?", false);
}

export async function executePlanOnly(options: RunOptions): Promise<void> {
  const store = await createRunStore(options.root, options.task);
  const context = await collectProjectContext(options.root, options.config, options.task);
  await saveInitialArtifacts(store, options.task, context);
  const plan = await generatePlan(options.provider, options.task, context, options.config.model);
  await store.writeText("plan.md", plan);
  logger.heading("Plan");
  logger.info(plan);
  logger.info(`Saved run artifacts: ${store.dir}`);
}

export async function executeRun(options: RunOptions): Promise<RunResult> {
  const startedAt = new Date().toISOString();
  const store = await createRunStore(options.root, options.task);
  let patchApplied = false;
  let validationPassed = false;
  let repairAttempts = 0;
  const finish = async (status: RunResult["status"]): Promise<RunResult> => {
    const result: RunResult = {
      task: options.task,
      status,
      startedAt,
      finishedAt: new Date().toISOString(),
      patchApplied,
      validationPassed,
      repairAttempts
    };
    await saveResult(store, result);
    return result;
  };

  const context = await collectProjectContext(options.root, options.config, options.task);
  await saveInitialArtifacts(store, options.task, context);
  const plan = await generatePlan(options.provider, options.task, context, options.config.model);
  await store.writeText("plan.md", plan);
  logger.heading("Plan");
  logger.info(plan);
  if (!options.config.autoApply && !(await askConfirm("Generate a patch for this plan?", false))) {
    return finish("cancelled");
  }

  const patch = await generatePatch(options.provider, options.task, plan, context, options.config.model);
  await store.writeText("patch.diff", patch);
  if (patch.startsWith("NEED_MORE_CONTEXT:")) {
    logger.warn(patch);
    return finish("failed");
  }
  const validation = validatePatch(patch);
  if (!validation.ok) {
    logger.error(`Patch validation failed:\n${validation.errors.join("\n")}`);
    return finish("failed");
  }
  const patchPath = path.join(store.dir, "patch.diff");
  const patchCheck = await checkPatchApplies(options.root, patchPath);
  if (!patchCheck.ok) {
    const message = `Patch cannot be applied by git:\n${patchCheck.error}`;
    await store.writeText("patch-check.log", message);
    logger.error(message);
    logger.info(`Saved run artifacts: ${store.dir}`);
    return finish("failed");
  }
  if (await gitStatus(options.root)) {
    logger.warn("Working tree has existing changes. Review the patch carefully.");
  }
  if (!(await confirmPatch(patch, options.config.autoApply))) {
    return finish("cancelled");
  }
  await applyPatch(options.root, patchPath);
  patchApplied = true;
  await store.writeText("applied.diff", await gitDiff(options.root));

  if (options.noTest) {
    logger.warn("Validation skipped by --no-test.");
    validationPassed = true;
    return finish("success");
  }

  const commands = await validationCommands(options.root, options.config, options.commands);
  if (commands.length === 0) {
    logger.warn("No validation commands configured or detected.");
    validationPassed = true;
    return finish("success");
  }

  let results = await runValidation(options.root, commands);
  await store.writeText("validation.log", formatValidationLog(results));
  validationPassed = allPassed(results);

  while (!validationPassed && repairAttempts < options.config.maxRepairAttempts) {
    repairAttempts += 1;
    logger.warn(`Validation failed. Attempting repair ${repairAttempts}/${options.config.maxRepairAttempts}.`);
    const repairContext = await collectProjectContext(options.root, options.config, options.task);
    const repairPatch = await generateRepairPatch(options.provider, options.task, repairContext, results, await gitDiff(options.root), options.config.model);
    await store.writeText(`repair-${repairAttempts}.diff`, repairPatch);
    if (repairPatch.startsWith("NEED_MORE_CONTEXT:")) {
      logger.warn(repairPatch);
      break;
    }
    const repairValidation = validatePatch(repairPatch);
    if (!repairValidation.ok) {
      logger.error(`Repair patch validation failed:\n${repairValidation.errors.join("\n")}`);
      break;
    }
    const repairPath = path.join(store.dir, `repair-${repairAttempts}.diff`);
    const repairCheck = await checkPatchApplies(options.root, repairPath);
    if (!repairCheck.ok) {
      const message = `Repair patch cannot be applied by git:\n${repairCheck.error}`;
      await store.writeText(`repair-${repairAttempts}-check.log`, message);
      logger.error(message);
      break;
    }
    logger.heading(`Repair Patch ${repairAttempts}`);
    logger.info(repairPatch);
    if (!options.config.autoApply && !(await askConfirm("Apply this repair patch?", false))) {
      break;
    }
    await applyPatch(options.root, repairPath);
    results = await runValidation(options.root, commands);
    await store.writeText(`repair-${repairAttempts}.log`, formatValidationLog(results));
    validationPassed = allPassed(results);
  }

  logger.info(`Saved run artifacts: ${store.dir}`);
  return finish(validationPassed ? "success" : "failed");
}

export async function executeFix(options: Omit<RunOptions, "task"> & { task?: string }): Promise<RunResult> {
  const task = options.task ?? "Fix failing validation commands";
  const commands = await validationCommands(options.root, options.config, options.commands);
  if (commands.length === 0) {
    logger.warn("No validation commands configured or detected.");
  }
  return executeRun({ ...options, task, commands });
}
