import { input } from "@inquirer/prompts";
import ora from "ora";
import { generateChatReply, type ChatMessage } from "../agent/chat.js";
import { classifyChatIntent } from "../agent/intent.js";
import { applyFileActions, formatCodeActionPlan, generateCodeActionPlan, validateCodeActionPlan } from "../agent/actions.js";
import { executePlanOnly } from "../agent/runtime.js";
import { createLlmProvider } from "../llm/factory.js";
import { collectProjectContext } from "../project/context.js";
import { resolveRuntimeConfig } from "../state/config.js";
import { createRunStore } from "../state/run-store.js";
import { requiresInstallConfirmation } from "../safety/command-policy.js";
import {
  isLongRunningCommand,
  parseStopBackgroundCommand,
  pruneStoppedCommands,
  startBackgroundCommand,
  stopBackgroundCommandById,
  stopBackgroundCommands,
  type RunningCommand
} from "../tools/background-command.js";
import { runValidationCommand } from "../tools/run-command.js";
import { formatExternalServices, listExternalServices, parseServiceCommand, stopExternalService } from "../tools/external-service.js";
import { askConfirm } from "../ui/confirm.js";
import { formatCompactCommandResult } from "../ui/command-output.js";
import { logger } from "../ui/logger.js";
import { diffCommand } from "./diff.js";
import { doctorCommand } from "./doctor.js";
import type { ValidationResult } from "../types.js";

export type ChatCliOptions = {
  model?: string;
  autoApply?: boolean;
  noTest?: boolean;
  maxRepairAttempts?: string;
  cmd?: string[];
};

export type ParsedChatInput =
  | { kind: "empty" }
  | { kind: "exit" }
  | { kind: "help" }
  | { kind: "clear" }
  | { kind: "doctor" }
  | { kind: "diff" }
  | { kind: "message"; message: string };

export function parseChatInput(value: string): ParsedChatInput {
  const trimmed = value.trim();
  if (!trimmed) return { kind: "empty" };
  if (trimmed === "/exit" || trimmed === "/quit") return { kind: "exit" };
  if (trimmed === "/help") return { kind: "help" };
  if (trimmed === "/clear") return { kind: "clear" };
  if (trimmed === "/doctor") return { kind: "doctor" };
  if (trimmed === "/diff") return { kind: "diff" };
  return { kind: "message", message: trimmed };
}

function printChatHelp(): void {
  logger.heading("Chat commands");
  logger.info([
    "/help              Show chat commands",
    "/doctor            Print project diagnostics",
    "/diff              Print current git diff and latest run patch path",
    "/clear             Clear in-memory conversation history",
    "/exit, /quit       Leave chat",
    "",
    "For coding or command execution, describe what you want in natural language.",
    "The model will infer the intent, then the CLI will ask before editing files or running commands.",
    "If validation commands fail after a code change, the agent will automatically propose repairs."
  ].join("\n"));
}

function formatRunningCommands(commands: RunningCommand[]): string {
  const active = pruneStoppedCommands(commands);
  if (active.length === 0) return "No active background commands.";
  return active
    .map((command) => `- id=${command.id}, command=${command.command}, pid=${command.process.pid ?? "unknown"}`)
    .join("\n");
}

function isReadOnlyProjectQuestion(message: string): boolean {
  const normalized = message.toLowerCase();
  return [
    "review",
    "inspect",
    "analyze",
    "analyse",
    "explain",
    "codebase",
    "current project",
    "this project",
    "审查",
    "检查",
    "分析",
    "解释",
    "看看",
    "当前项目",
    "这个项目"
  ].some((keyword) => normalized.includes(keyword));
}

function shouldRegenerateContextualReply(message: string, answer: string): boolean {
  const normalized = `${message}\n${answer}`.toLowerCase();
  return [
    "贴",
    "提供代码",
    "看到主要文件"
  ].some((keyword) => normalized.includes(keyword));
}

function isCreateOrScaffoldTask(task: string): boolean {
  const normalized = task.toLowerCase();
  return [
    "创建",
    "新建",
    "搭建",
    "生成",
    "create",
    "new project",
    "scaffold",
    "set up",
    "setup"
  ].some((keyword) => normalized.includes(keyword));
}

export function inspectExistingProject(context: import("../types.js").ProjectContext): ExistingProjectState | undefined {
  const markerPatterns = [
    /^package\.json$/,
    /^pnpm-lock\.yaml$/,
    /^pom\.xml$/,
    /^build\.gradle(\.kts)?$/,
    /^settings\.gradle(\.kts)?$/,
    /^gradlew(\.bat)?$/,
    /^go\.mod$/,
    /^Cargo\.toml$/,
    /^pyproject\.toml$/,
    /^requirements\.txt$/,
    /^src\//
  ];
  const sourcePatterns = [
    /^src\//,
    /\.(ts|tsx|js|jsx|kt|java|py|go|rs)$/i
  ];
  const markers = context.fileTree.filter((file) => markerPatterns.some((pattern) => pattern.test(file))).slice(0, 12);
  const sourceFiles = context.fileTree.filter((file) => sourcePatterns.some((pattern) => pattern.test(file))).slice(0, 12);
  if (markers.length === 0 && sourceFiles.length === 0) return undefined;
  return { markers, sourceFiles };
}

export function formatExistingProjectState(state: ExistingProjectState): string {
  const lines = ["Existing project files detected before scaffolding."];
  if (state.markers.length > 0) {
    lines.push("", "Project markers:", ...state.markers.map((file) => `- ${file}`));
  }
  if (state.sourceFiles.length > 0) {
    lines.push("", "Source files:", ...state.sourceFiles.map((file) => `- ${file}`));
  }
  return lines.join("\n");
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

type ProgressUpdate = (message: string) => void;
type EnvironmentIssue = {
  summary: string;
  details: string[];
  suggestions: string[];
};
type ExistingProjectState = {
  markers: string[];
  sourceFiles: string[];
};

async function withProgress<T>(message: string, task: (update: ProgressUpdate) => Promise<T>): Promise<T> {
  const started = Date.now();
  let currentMessage = message;
  const spinner = ora(message).start();
  const timer = setInterval(() => {
    spinner.text = `${currentMessage} (${formatElapsed(Date.now() - started)})`;
  }, 1000);
  const update: ProgressUpdate = (nextMessage) => {
    currentMessage = nextMessage;
    spinner.text = `${currentMessage} (${formatElapsed(Date.now() - started)})`;
  };
  try {
    const result = await task(update);
    spinner.succeed(`${currentMessage} (${formatElapsed(Date.now() - started)})`);
    return result;
  } catch (error) {
    spinner.fail(`${currentMessage} failed (${formatElapsed(Date.now() - started)})`);
    throw error;
  } finally {
    clearInterval(timer);
  }
}

export function analyzeEnvironmentFailures(results: ValidationResult[]): EnvironmentIssue | undefined {
  const details: string[] = [];
  const suggestions = new Set<string>();

  for (const result of results.filter((item) => item.exitCode !== 0)) {
    const output = `${result.stderr}\n${result.stdout}`;
    const lower = output.toLowerCase();
    const command = result.command;

    if (/\.\/gradlew.*no such file or directory/i.test(output) || (command.includes("./gradlew") && lower.includes("no such file or directory"))) {
      details.push(`Gradle wrapper is missing for "${command}".`);
      suggestions.add("Generate the Gradle wrapper after installing Gradle, or provide wrapper files in the project.");
      suggestions.add("Skip service startup and curl tests until `./gradlew build` succeeds.");
      continue;
    }

    const missingCommand = output.match(/(?:^|\n)\/bin\/sh:\s*(?:line \d+:\s*)?([^:\n]+): command not found/i);
    if (result.exitCode === 127 || missingCommand) {
      const tool = missingCommand?.[1]?.trim() || command.split(/\s+/)[0] || "required tool";
      details.push(`Missing command while running "${command}": ${tool}`);
      if (tool.includes("gradle")) {
        suggestions.add("Install Gradle first, or use an environment that already has Gradle available before running `gradle wrapper`.");
        suggestions.add("After Gradle is available, rerun the wrapper/build commands.");
      } else {
        suggestions.add(`Install or add "${tool}" to PATH, then rerun the command.`);
      }
      continue;
    }

    if (/curl:\s*\(7\).*failed to connect/i.test(output) || lower.includes("couldn't connect to server")) {
      details.push(`Service was not reachable while running "${command}".`);
      suggestions.add("Start the service successfully before running curl endpoint tests.");
      suggestions.add("Check the earlier build/start command output first; curl failures after a start failure are usually downstream environment failures.");
      continue;
    }

    if (lower.includes("enotfound") || lower.includes("could not resolve host") || lower.includes("network connectivity")) {
      details.push(`Network access failed while running "${command}".`);
      suggestions.add("Check registry/network/proxy access, then rerun the command.");
      continue;
    }
  }

  if (details.length === 0) return undefined;
  return {
    summary: "Validation stopped because the local development environment is missing required tools or services.",
    details,
    suggestions: [...suggestions]
  };
}

export function formatEnvironmentIssue(issue: EnvironmentIssue): string {
  return [
    issue.summary,
    "",
    "Details:",
    ...issue.details.map((detail) => `- ${detail}`),
    "",
    "Suggested next steps:",
    ...issue.suggestions.map((suggestion) => `- ${suggestion}`)
  ].join("\n");
}

async function runInternalServiceCommand(command: string, history: ChatMessage[]): Promise<boolean> {
  const serviceCommand = parseServiceCommand(command);
  if (!serviceCommand) return false;
  if (serviceCommand.kind === "list") {
    const services = await withProgress("Discovering local services", () => listExternalServices(serviceCommand.port));
    const output = formatExternalServices(services);
    logger.heading("External services");
    logger.info(output);
    history.push({ role: "assistant", content: output });
    return true;
  }
  const stopped = await withProgress(`Stopping external service ${serviceCommand.pid}`, () => stopExternalService(serviceCommand.pid));
  const message = stopped ? `Stopped external service pid ${serviceCommand.pid}.` : `Failed to stop external service pid ${serviceCommand.pid}.`;
  logger.info(message);
  history.push({ role: "assistant", content: message });
  return true;
}

async function runChatCommand(root: string, command: string, runningCommands: RunningCommand[], history: ChatMessage[]): Promise<void> {
  const stopTarget = parseStopBackgroundCommand(command);
  if (stopTarget !== undefined) {
    if (stopTarget === "all") {
      const stopped = await stopBackgroundCommands(runningCommands);
      const message = stopped > 0 ? `Stopped ${stopped} background command(s).` : "No running background commands found.";
      logger.info(message);
      history.push({ role: "assistant", content: message });
      return;
    }
    const stopped = await stopBackgroundCommandById(runningCommands, stopTarget);
    const message = stopped ? `Stopped background command [${stopTarget}].` : `No running background command found with id ${stopTarget}.`;
    logger.info(message);
    history.push({ role: "assistant", content: message });
    return;
  }
  if (await runInternalServiceCommand(command, history)) {
    return;
  }
  if (isLongRunningCommand(command)) {
    const running = startBackgroundCommand(root, command);
    runningCommands.push(running);
    const message = `Started background command [${running.id}]: ${command}`;
    logger.success(message);
    logger.info("你可以用自然语言要求停止后台服务，模型会返回具体停止命令供你确认。");
    history.push({ role: "assistant", content: message });
    return;
  }
  const result = await withProgress(`Running command: ${command}`, () => runValidationCommand(root, command));
  const output = formatCompactCommandResult(result);
  logger.heading("Command result");
  logger.info(output);
  history.push({ role: "assistant", content: output });
}

async function runRepairLoop(params: {
  root: string;
  config: import("../types.js").RuntimeConfig;
  provider: import("../llm/provider.js").LlmProvider;
  history: ChatMessage[];
  runningCommands: RunningCommand[];
  task: string;
}): Promise<void> {
  const { root, config, provider, history, runningCommands, task } = params;
  let failedResults: ValidationResult[] = [{ command: task, exitCode: 1, stdout: "", stderr: "", durationMs: 0 }];

  for (let attempt = 0; attempt < config.maxRepairAttempts && failedResults.length > 0; attempt++) {
    logger.warn(`Auto-repair attempt ${attempt + 1}/${config.maxRepairAttempts}.`);

    const repairContext = await withProgress(`Collecting repair context ${attempt + 1}/${config.maxRepairAttempts}`, () => collectProjectContext(root, config, task));
    const errorSummary = failedResults
      .map((r) => `$ ${r.command}\nexitCode: ${r.exitCode}\n${r.stderr || r.stdout}`)
      .join("\n\n");

    let repairPlan;
    try {
      repairPlan = await withProgress(`Generating repair ${attempt + 1}/${config.maxRepairAttempts}`, (update) => generateCodeActionPlan({
          provider,
          model: config.model,
          task: `Fix the following validation errors from the previous code change.\nOriginal task: ${task}\n\nCommand errors:\n${errorSummary}\n\nRead the current file contents and produce corrected versions.`,
        context: repairContext,
        onProgress: (message) => update(message.replace("Generating file actions", `Generating repair ${attempt + 1}/${config.maxRepairAttempts}`))
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Repair generation failed: ${message}`);
      history.push({ role: "assistant", content: `修复生成失败：${message}` });
      break;
    }

    const repairErrors = validateCodeActionPlan(root, repairPlan);
    if (repairErrors.length > 0) {
      logger.error(`Repair validation failed:\n${repairErrors.join("\n")}`);
      history.push({ role: "assistant", content: `修复校验失败：${repairErrors.join("; ")}` });
      break;
    }

    logger.heading(`Repair ${attempt + 1}/${config.maxRepairAttempts}`);
    logger.info(formatCodeActionPlan(repairPlan));

    if (!(config.autoApply || await askConfirm("Apply this repair?", true))) {
      logger.info("Repair skipped.");
      history.push({ role: "assistant", content: "用户跳过修复。" });
      break;
    }

    if (repairPlan.files.length > 0) {
      await applyFileActions(root, repairPlan.files);
      logger.success("Repair files written.");
      history.push({ role: "assistant", content: `已修复文件：${repairPlan.files.map((f) => f.path).join(", ")}` });
    }

    const newResults: ValidationResult[] = [];
    for (const cmd of repairPlan.commands) {
      if (isLongRunningCommand(cmd.command) || requiresInstallConfirmation(cmd.command)) {
        if (await askConfirm(`Run "${cmd.command}"?`, false)) {
          await runChatCommand(root, cmd.command, runningCommands, history);
        }
      } else {
        if (config.autoApply || await askConfirm(`Run "${cmd.command}"?`, false)) {
          const result = await withProgress(`Running command: ${cmd.command}`, () => runValidationCommand(root, cmd.command));
          newResults.push(result);
          const output = formatCompactCommandResult(result);
          logger.heading("Command result");
          logger.info(output);
          history.push({ role: "assistant", content: output });
        }
      }
    }

    failedResults = newResults.filter((r) => r.exitCode !== 0);
    if (failedResults.length === 0 && newResults.length > 0) {
      logger.success("All validation commands passed after repair.");
    }
  }

  if (failedResults.length > 0) {
    logger.warn(`Repair did not resolve all errors after ${config.maxRepairAttempts} attempt(s).`);
    logger.info("You can describe the remaining errors or run /fix to retry.");
  }
}

export async function chatCommand(root: string, options: ChatCliOptions): Promise<void> {
  const config = await resolveRuntimeConfig(root, {
    model: options.model,
    autoApply: options.autoApply,
    maxRepairAttempts: options.maxRepairAttempts ? Number(options.maxRepairAttempts) : undefined,
    validationCommands: options.cmd
  });
  const provider = createLlmProvider(config);
  const history: ChatMessage[] = [];
  let runningCommands: RunningCommand[] = [];
  const store = await createRunStore(root, "chat session");
  await store.writeText("task.txt", "chat session");
  await store.writeJson("transcript.json", history);

  logger.heading("Code Agent Chat");
  logger.info("Type naturally. The CLI asks before editing files or running commands. Type /help for controls.");

  while (true) {
    let raw: string;
    try {
      raw = await input({ message: "you" });
    } catch {
      logger.info("");
      const stopped = await stopBackgroundCommands(runningCommands);
      if (stopped > 0) {
        logger.info(`Stopped ${stopped} background command(s).`);
      }
      logger.info("Chat ended.");
      return;
    }

    const parsed = parseChatInput(raw);
    if (parsed.kind === "empty") continue;
    if (parsed.kind === "exit") {
      const stopped = await stopBackgroundCommands(runningCommands);
      if (stopped > 0) {
        logger.info(`Stopped ${stopped} background command(s).`);
      }
      logger.info("Chat ended.");
      return;
    }
    if (parsed.kind === "help") {
      printChatHelp();
      continue;
    }
    if (parsed.kind === "clear") {
      history.length = 0;
      await store.writeJson("transcript.json", history);
      logger.info("Conversation history cleared.");
      continue;
    }
    if (parsed.kind === "doctor") {
      await withProgress("Running doctor", () => doctorCommand(root));
      continue;
    }
    if (parsed.kind === "diff") {
      await withProgress("Loading diff", () => diffCommand(root));
      continue;
    }

    runningCommands = pruneStoppedCommands(runningCommands);
    history.push({ role: "user", content: parsed.message });
    const context = await withProgress("Collecting project context", () => collectProjectContext(root, config, parsed.message));
    if (isReadOnlyProjectQuestion(parsed.message)) {
      const reply = await withProgress("Generating project review", () => generateChatReply({
        provider,
        model: config.model,
        message: parsed.message,
        history,
        context
      }));
      history.push({ role: "assistant", content: reply });
      await store.writeJson("transcript.json", history);
      logger.heading("assistant");
      logger.info(reply);
      continue;
    }

    const intent = await withProgress("Classifying request", () => classifyChatIntent({
      provider,
      model: config.model,
      message: parsed.message,
      history,
      context,
      runtimeContext: formatRunningCommands(runningCommands)
    }));

    if (intent.intent === "code_change") {
      logger.heading("Suggested code change");
      logger.info(`Task: ${intent.task}`);
      logger.info(`Reason: ${intent.reason}`);
      const shouldGenerate = await askConfirm("Generate file actions for this task?", true);
      if (!shouldGenerate) {
        const shouldPlan = await askConfirm("Generate a plan only instead?", true);
        if (shouldPlan) {
          await executePlanOnly({ root, task: intent.task, config, provider });
          history.push({ role: "assistant", content: `已按确认生成计划：${intent.task}` });
        } else {
          logger.info("No code changes made.");
          history.push({ role: "assistant", content: "用户取消了代码修改，没有改动文件。" });
        }
        await store.writeJson("transcript.json", history);
        continue;
      }

      const actionContext = await withProgress("Refreshing project context", () => collectProjectContext(root, config, intent.task));
      const existingProject = isCreateOrScaffoldTask(intent.task) ? inspectExistingProject(actionContext) : undefined;
      if (existingProject) {
        const message = formatExistingProjectState(existingProject);
        logger.heading("Existing project detected");
        logger.info(message);
        history.push({ role: "assistant", content: message });
        const shouldAdaptExisting = config.autoApply || await askConfirm("Continue by adapting the existing project instead of creating from an empty directory?", true);
        if (!shouldAdaptExisting) {
          logger.info("No code changes made.");
          history.push({ role: "assistant", content: "用户取消了在已有项目上继续生成代码。" });
          await store.writeJson("transcript.json", history);
          continue;
        }
      }
      let actionPlan;
      try {
        actionPlan = await withProgress("Generating file actions", (update) => generateCodeActionPlan({
          provider,
          model: config.model,
          task: intent.task,
          context: actionContext,
          onProgress: update
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Could not parse model file actions: ${message}`);
        history.push({ role: "assistant", content: `无法解析模型返回的文件动作：${message}` });
        await store.writeJson("transcript.json", history);
        continue;
      }
      await store.writeJson("last-code-actions.json", actionPlan);
      logger.heading("Proposed file actions");
      logger.info(formatCodeActionPlan(actionPlan));
      const errors = validateCodeActionPlan(root, actionPlan);
      if (errors.length > 0) {
        logger.error(`Code action validation failed:\n${errors.join("\n")}`);
        history.push({ role: "assistant", content: `代码动作校验失败：${errors.join("; ")}` });
        await store.writeJson("transcript.json", history);
        continue;
      }
      if (actionPlan.files.length > 0 && (config.autoApply || await askConfirm("Write these files now?", false))) {
        await applyFileActions(root, actionPlan.files);
        logger.success("Files written.");
        history.push({ role: "assistant", content: `已写入文件：${actionPlan.files.map((file) => file.path).join(", ")}` });
      } else if (actionPlan.files.length > 0) {
        logger.info("No files written.");
        history.push({ role: "assistant", content: "用户取消写入文件。" });
        await store.writeJson("transcript.json", history);
        continue;
      }

      // Run suggested commands, tracking validation results for auto-repair
      const validationResults: ValidationResult[] = [];
      let environmentIssue: EnvironmentIssue | undefined;
      for (const cmd of actionPlan.commands) {
        const isInstall = requiresInstallConfirmation(cmd.command);
        const isLongRunning = isLongRunningCommand(cmd.command);
        const message = isInstall
          ? `This looks like an install command. Run "${cmd.command}"?`
          : `Run "${cmd.command}"?`;
        if (await askConfirm(message, false)) {
          if (isLongRunning || isInstall) {
            await runChatCommand(root, cmd.command, runningCommands, history);
          } else {
            const result = await withProgress(`Running command: ${cmd.command}`, () => runValidationCommand(root, cmd.command));
            validationResults.push(result);
            const output = formatCompactCommandResult(result);
            logger.heading("Command result");
            logger.info(output);
            history.push({ role: "assistant", content: output });
            environmentIssue = analyzeEnvironmentFailures([result]);
            if (environmentIssue) {
              const message = formatEnvironmentIssue(environmentIssue);
              logger.heading("Environment issue");
              logger.warn(message);
              history.push({ role: "assistant", content: message });
              break;
            }
          }
        }
      }

      if (environmentIssue) {
        logger.info("Auto-repair skipped because this failure is caused by the local environment, not the generated code.");
        history.push({ role: "assistant", content: "已跳过自动修复：当前失败来自本地开发环境缺失或服务未启动，不是代码补丁可直接修复的问题。" });
      } else if (validationResults.some((r) => r.exitCode !== 0)) {
        const errorSummary = validationResults
          .filter((r) => r.exitCode !== 0)
          .map((r) => `$ ${r.command}\nexitCode: ${r.exitCode}\n${r.stderr || r.stdout}`)
          .join("\n\n");
        await runRepairLoop({
          root,
          config,
          provider,
          history,
          runningCommands,
          task: `Original task: ${intent.task}\n\nCommand errors:\n${errorSummary}`
        });
      }

      await store.writeJson("transcript.json", history);
      continue;
    }

    if (intent.intent === "command") {
      logger.heading("Suggested command");
      logger.info(`Command: ${intent.command}`);
      logger.info(`Reason: ${intent.reason}`);
      const isInstall = requiresInstallConfirmation(intent.command);
      const isLongRunning = isLongRunningCommand(intent.command);
      const message = isInstall
        ? "This looks like an install command. Run it?"
        : "Run this command?";
      if (await askConfirm(message, false)) {
        if (isLongRunning || isInstall) {
          await runChatCommand(root, intent.command, runningCommands, history);
        } else {
          const result = await withProgress(`Running command: ${intent.command}`, () => runValidationCommand(root, intent.command));
          const output = formatCompactCommandResult(result);
          logger.heading("Command result");
          logger.info(output);
          history.push({ role: "assistant", content: output });

          if (result.exitCode !== 0) {
            const environmentIssue = analyzeEnvironmentFailures([result]);
            if (environmentIssue) {
              const message = formatEnvironmentIssue(environmentIssue);
              logger.heading("Environment issue");
              logger.warn(message);
              history.push({ role: "assistant", content: message });
            } else {
              const shouldRepair = await askConfirm("Command failed. Try to fix the code?", true);
              if (shouldRepair) {
                const repairTask = `Command "${intent.command}" failed. Fix the code.\n\nError:\n${result.stderr || result.stdout}`;
                await runRepairLoop({
                  root,
                  config,
                  provider,
                  history,
                  runningCommands,
                  task: repairTask
                });
              }
            }
          }
        }
      } else {
        logger.info("Command not run.");
        history.push({ role: "assistant", content: `用户取消执行命令：${intent.command}` });
      }
      await store.writeJson("transcript.json", history);
      continue;
    }

    let reply = intent.answer;
    if (!reply.trim() || shouldRegenerateContextualReply(parsed.message, reply)) {
      reply = await withProgress("Generating response", () => generateChatReply({
        provider,
        model: config.model,
        message: parsed.message,
        history,
        context
      }));
    }
    history.push({ role: "assistant", content: reply });
    await store.writeJson("transcript.json", history);
    logger.heading("assistant");
    logger.info(reply);
  }
}
