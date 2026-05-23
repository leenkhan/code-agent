import { input } from "@inquirer/prompts";
import path from "node:path";
import readline from "node:readline";
import fs from "fs-extra";
import ora from "ora";
import { generateChatReply, type ChatMessage } from "../agent/chat.js";
import { classifyChatIntent } from "../agent/intent.js";
import { applyFileActions, createFileActionsPatch, formatCodeActionPlan, generateCodeActionPlan, validateCodeActionPlan, generateEnvironmentFix } from "../agent/actions.js";
import { executePlanOnly } from "../agent/runtime.js";
import { generateTaskPlan, normalizeTaskPlanForContext } from "../agent/task-planner.js";
import { executeTask, resolveResumeStepIndex, type ExecutorEvent } from "../agent/task-executor.js";
import { createLlmProvider } from "../llm/factory.js";
import { collectProjectContext } from "../project/context.js";
import { resolveRuntimeConfig } from "../state/config.js";
import { createRunStore } from "../state/run-store.js";
import { createTaskStore, listTasks, loadTaskStore } from "../state/task-store.js";
import type { TaskPlan, TaskState } from "../types.js";
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
import { appVersion } from "../version.js";
import { formatCompactCommandResult } from "../ui/command-output.js";
import { logger } from "../ui/logger.js";
import { diffCommand } from "./diff.js";
import { doctorCommand } from "./doctor.js";
import type { ValidationResult } from "../types.js";
import { buildProjectProfile, classifyEnvironmentFailures, shouldAttemptEnvironmentFix as shouldAttemptEnvironmentFixFromProfile } from "../project/profile.js";

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
  | { kind: "tasks" }
  | { kind: "resume"; taskId?: string }
  | { kind: "plan"; task?: string }
  | { kind: "plan_exit" }
  | { kind: "apply_plan" }
  | { kind: "unknown_command"; command: string }
  | { kind: "message"; message: string };

type PlanModeState = {
  goal?: string;
  messages: ChatMessage[];
  lastSummary?: string;
};

type ChatInputResult =
  | { kind: "line"; value: string }
  | { kind: "plan_exit_shortcut" };

type KeypressLike = {
  name?: string;
  sequence?: string;
  shift?: boolean;
};

const planExitShortcutReason = "plan-exit-shortcut";

export function isPlanExitShortcutKey(key: KeypressLike): boolean {
  return (key.name === "tab" && key.shift === true) || key.sequence === "\u001b[Z";
}

export function parseChatInput(value: string): ParsedChatInput {
  const trimmed = value.trim();
  if (!trimmed) return { kind: "empty" };
  if (trimmed === "/exit" || trimmed === "/quit") return { kind: "exit" };
  if (trimmed === "/help") return { kind: "help" };
  if (trimmed === "/clear") return { kind: "clear" };
  if (trimmed === "/doctor") return { kind: "doctor" };
  if (trimmed === "/diff") return { kind: "diff" };
  if (trimmed === "/tasks") return { kind: "tasks" };
  if (trimmed === "/apply-plan") return { kind: "apply_plan" };
  if (trimmed === "/plan" || trimmed.startsWith("/plan ")) {
    const task = trimmed.slice("/plan".length).trim();
    if (task === "exit") return { kind: "plan_exit" };
    return { kind: "plan", task: task || undefined };
  }
  if (trimmed.startsWith("/resume")) {
    const taskId = trimmed.slice("/resume".length).trim();
    return { kind: "resume", taskId: taskId || undefined };
  }
  if (trimmed.startsWith("/")) {
    return { kind: "unknown_command", command: trimmed.split(/\s+/, 1)[0] ?? trimmed };
  }
  return { kind: "message", message: trimmed };
}

function printChatHelp(): void {
  logger.heading("Chat commands");
  logger.info([
    "/help              Show chat commands",
    "/doctor            Print project diagnostics",
    "/diff              Print current git diff and latest run patch path",
    "/tasks             List saved tasks and their status",
    "/resume [task-id]  Resume a paused or incomplete task",
    "/plan [goal]       Enter multi-turn plan mode; does not edit files or run commands",
    "/apply-plan        Convert the current plan-mode discussion into an executable task plan",
    "Shift+Tab          Leave plan mode and return to normal chat",
    "/clear             Clear in-memory conversation history",
    "/exit, /quit       Leave chat",
    "",
    "For coding or command execution, describe what you want in natural language.",
    "The model will infer the intent, then the CLI will ask before editing files or running commands.",
    "Complex multi-step tasks are automatically decomposed into a plan and executed step by step.",
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

function printPatchPreview(name: string, patch: string): void {
  if (!patch.trim()) return;
  logger.heading(`Patch: ${name}`);
  logger.info(patch);
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

function isComplexTask(task: string): boolean {
  const normalized = task.toLowerCase();
  const complexKeywords = [
    "auth", "认证", "登录", "注册", "logout",
    "fullstack", "全栈",
    "complete", "完整",
    "system", "系统",
    "crud",
    "database", "数据库", "migration",
    "api", "rest",
    "middleware", "中间件",
    "deploy", "部署",
    "e2e", "integration test",
    "refactor", "重构",
    "migrate", "迁移",
    "支付", "payment",
    "通知", "notification",
    "搜索", "search",
    "权限", "permission",
    "upload", "上传",
    "export", "导出",
    "spring", "kotlin", "java ", "后端", "服务框架",
    "email", "jwt", "token", "session",
    "sqlite", "sqllit", "mysql", "postgres"
  ];
  const matchCount = complexKeywords.filter((kw) => normalized.includes(kw)).length;
  const hasOperationalGoal = isTaskGoalMessage(task);
  const hasCreationIntent = isCreateOrScaffoldTask(task);
  // Complex if 2+ keywords match, or task mentions "step" / "multiple"
  if (matchCount >= 2) return true;
  const multiStepIndicators = [
    "and also", "同时",
    "step", "步骤",
    "first", "then", "首先", "然后",
    "multiple", "多个", "先", "再", "然后"
  ];
  if (hasOperationalGoal) return true;
  if (hasCreationIntent && matchCount < 2) return false;
  if (!hasCreationIntent && normalized.includes("以及") && matchCount > 0) return true;
  if (multiStepIndicators.some((kw) => normalized.includes(kw))) return true;
  // Tasks with many words are likely complex
  if (task.split(/\s+/).length > 15) return true;
  return false;
}

function isTaskGoalMessage(message: string): boolean {
  const normalized = message.toLowerCase();
  const goalKeywords = [
    "完成",
    "验证",
    "测试链路",
    "跑通",
    "启动服务",
    "运行服务",
    "启动并测试",
    "运行并测试",
    "修复后验证",
    "complete",
    "verify",
    "validate",
    "run and test",
    "start service",
    "start the service",
    "run the service",
    "after fixing",
    "e2e",
    "end-to-end"
  ];
  const strongCompositeGoals = [
    "启动服务并完成测试",
    "启动并测试",
    "运行并测试",
    "修复后验证",
    "完成测试链路",
    "run and test",
    "start service and test",
    "start the service and test",
    "after fixing"
  ];
  if (strongCompositeGoals.some((keyword) => normalized.includes(keyword))) return true;
  const executionKeywords = [
    "测试",
    "test",
    "build",
    "构建",
    "curl",
    "接口",
    "endpoint",
    "服务",
    "service",
    "验证",
    "validate",
    "verify"
  ];
  const executionMatches = executionKeywords.filter((keyword) => normalized.includes(keyword)).length;
  return goalKeywords.some((keyword) => normalized.includes(keyword)) && executionMatches >= 2;
}

export function inspectExistingProject(context: import("../types.js").ProjectContext): ExistingProjectState | undefined {
  const markers = context.fileTree.filter((file) => /^(?:package\.json|pnpm-lock\.yaml|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|gradlew(?:\.bat)?|go\.mod|Cargo\.toml|pyproject\.toml|requirements\.txt|src\/)/.test(file)).slice(0, 12);
  const sourceFiles = context.fileTree.filter((file) => /^src\//.test(file) || /\.(ts|tsx|js|jsx|kt|java|py|go|rs|swift|php|rb|cs)$/i.test(file)).slice(0, 12);
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

async function readChatInput(planModeActive: boolean): Promise<ChatInputResult> {
  const message = planModeActive ? "you [PLAN - Shift+Tab exits]" : "you";
  if (!planModeActive) {
    return { kind: "line", value: await input({ message }) };
  }

  const controller = new AbortController();
  let shortcutPressed = false;
  const stdin = process.stdin;
  const onKeypress = (_value: string, key: KeypressLike): void => {
    if (!isPlanExitShortcutKey(key)) return;
    shortcutPressed = true;
    controller.abort(planExitShortcutReason);
  };

  readline.emitKeypressEvents(stdin);
  stdin.on("keypress", onKeypress);
  try {
    return {
      kind: "line",
      value: await input({ message }, { signal: controller.signal })
    };
  } catch (error) {
    if (shortcutPressed || controller.signal.reason === planExitShortcutReason) {
      return { kind: "plan_exit_shortcut" };
    }
    throw error;
  } finally {
    stdin.removeListener("keypress", onKeypress);
  }
}

export function analyzeEnvironmentFailures(results: ValidationResult[]): EnvironmentIssue | undefined {
  const issue = classifyEnvironmentFailures(results);
  if (!issue) return undefined;
  const details = [...issue.details];
  const suggestions = new Set(issue.suggestions);

  for (const result of results.filter((item) => item.exitCode !== 0)) {
    const output = `${result.stderr}\n${result.stdout}`;
    const lower = output.toLowerCase();
    const command = result.command;
    const javaMajor = parseJavaMajorVersion(output);
    if (javaMajor !== undefined && javaMajor < 17) {
      details.push(`Java ${javaMajor} was detected while running "${command}". Spring Boot 3 and recent Kotlin builds usually require Java 17 or newer.`);
      suggestions.add("Install JDK 17 or newer and set JAVA_HOME/PATH to that JDK before building the service.");
    }
    const missingWrapperCommand = extractMissingGradleWrapperCommand(command, output);
    if (missingWrapperCommand) {
      details.push(`Gradle wrapper is missing for "${missingWrapperCommand}"${missingWrapperCommand === command ? "" : ` from "${command}"`}.`);
      suggestions.add("Generate the Gradle wrapper after installing Gradle, or provide wrapper files in the project.");
      suggestions.add("Skip service startup and curl tests until `./gradlew build` succeeds.");
    }
    if (command.includes("gradle") && lower.includes("command not found")) {
      suggestions.add("Install Gradle first, or use an environment that already has Gradle available before running `gradle wrapper`.");
      suggestions.add("After Gradle is available, rerun the wrapper/build commands.");
    }
    if (command.includes("mvnw") && lower.includes("invalid or corrupt jarfile")) {
      details.push(`Maven wrapper jar is invalid or corrupt while running "${command}".`);
      suggestions.add("Regenerate or restore the Maven wrapper files, especially `.mvn/wrapper/maven-wrapper.jar`.");
      suggestions.add("If system Maven is available, run the equivalent `mvn ...` command or remove the broken wrapper from the project.");
    }
    const mavenResolutionIssue = command.includes("mvn") && (
      lower.includes("could not transfer artifact") ||
      lower.includes("could not resolve dependencies") ||
      lower.includes("could not resolve plugin") ||
      lower.includes("failed to transfer") ||
      lower.includes("spring-boot-buildpack-platform") ||
      lower.includes("spring-boot-maven-plugin")
    );
    if (command.includes("mvn") && lower.includes(".m2/repository")) {
      details.push(`Maven could not write to the local repository while running "${command}".`);
      suggestions.add("You can also set a writable local repository with `mvn -Dmaven.repo.local=/tmp/m2 test`.");
    }
    if (mavenResolutionIssue) {
      details.push(`Maven could not resolve or download dependencies/plugins while running "${command}".`);
      if (lower.includes("spring-boot-buildpack-platform") || lower.includes("spring-boot-maven-plugin")) {
        details.push("Spring Boot plugin resolution failed before the service could start.");
      }
      suggestions.add("Check Maven repository access, proxy, and mirror settings.");
    }
  }

  return {
    summary: issue.summary,
    details,
    suggestions: [...suggestions]
  };
}

function parseJavaMajorVersion(output: string): number | undefined {
  const match = output.match(/(?:java|openjdk)\s+version\s+"([^"]+)"/i);
  if (!match) return undefined;
  const version = match[1] ?? "";
  const firstNumber = Number(version.split(".")[0]);
  if (!Number.isFinite(firstNumber)) return undefined;
  if (firstNumber === 1) {
    const legacyMajor = Number(version.split(".")[1]);
    return Number.isFinite(legacyMajor) ? legacyMajor : undefined;
  }
  return firstNumber;
}

function extractMissingGradleWrapperCommand(command: string, output: string): string | undefined {
  const wrapperMissing = /(?:\.\/gradlew|gradlew).*no such file or directory/i.test(output)
    || /zsh:\s*no such file or directory:\s*\.\/gradlew/i.test(output)
    || /(?:\.\/gradlew|gradlew):\s*not found/i.test(output);
  if (!wrapperMissing && !(command.includes("./gradlew") && output.toLowerCase().includes("no such file or directory"))) {
    return undefined;
  }
  const gradlePart = command.split(/\s*&&\s*/).find((part) => part.includes("./gradlew"));
  return gradlePart?.trim() || command;
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

export function shouldAttemptEnvironmentFix(issue: EnvironmentIssue): boolean {
  const text = `${issue.details.join("\n")}\n${issue.suggestions.join("\n")}`.toLowerCase();
  if (text.includes("service was not reachable") || text.includes("start the service successfully")) return false;
  if (text.includes("maven could not resolve or download dependencies/plugins")) return false;
  if (text.includes("maven could not write to the local repository")) return false;
  if (text.includes("spring boot plugin resolution failed")) return false;
  if (text.includes("could not transfer artifact") || text.includes("could not resolve plugin") || text.includes("could not resolve dependencies")) return false;
  return shouldAttemptEnvironmentFixFromProfile({ kind: "unknown", summary: issue.summary, details: issue.details, suggestions: issue.suggestions });
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

async function linkLocalTypeScriptToolchain(root: string): Promise<void> {
  const packageJsonPath = path.join(root, "package.json");
  if (!(await fs.pathExists(packageJsonPath))) return;
  const repoNodeModules = path.resolve(process.cwd(), "node_modules");
  const repoTypescript = path.join(repoNodeModules, "typescript");
  const repoNodeTypes = path.join(repoNodeModules, "@types", "node");
  if (!(await fs.pathExists(repoTypescript))) return;

  const projectNodeModules = path.join(root, "node_modules");
  const projectBin = path.join(projectNodeModules, ".bin");
  await fs.ensureDir(projectBin);
  await fs.ensureSymlink(repoTypescript, path.join(projectNodeModules, "typescript"), "dir");
  if (await fs.pathExists(repoNodeTypes)) {
    await fs.ensureDir(path.join(projectNodeModules, "@types"));
    await fs.ensureSymlink(repoNodeTypes, path.join(projectNodeModules, "@types", "node"), "dir");
  }
  const tscBin = path.join(projectBin, "tsc");
  if (!(await fs.pathExists(tscBin))) {
    await fs.writeFile(tscBin, [
      "#!/usr/bin/env node",
      "import '../typescript/bin/tsc';",
      ""
    ].join("\n"), { mode: 0o755 });
  }
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

async function handleTasksCommand(root: string): Promise<void> {
  const tasks = await listTasks(root);
  if (tasks.length === 0) {
    logger.info("No saved tasks found.");
    return;
  }
  logger.heading("Saved tasks");
  for (const task of tasks) {
    const statusIcon = task.status === "completed" ? "✅" : task.status === "failed" ? "❌" : task.status === "running" ? "🔄" : "⏸️";
    logger.info(`${statusIcon} ${task.taskId}`);
    logger.info(`   Goal: ${task.goal}`);
    logger.info(`   Status: ${task.status} | Updated: ${task.updatedAt}`);
  }
  logger.info("");
  logger.info("Use /resume <task-id> to continue a paused or incomplete task.");
}

async function handleResumeCommand(
  root: string,
  taskId: string | undefined,
  config: import("../types.js").RuntimeConfig,
  provider: import("../llm/provider.js").LlmProvider,
  history: ChatMessage[],
  store: import("../state/run-store.js").RunStore
): Promise<void> {
  if (!taskId) {
    // List tasks and let user pick
    const tasks = await listTasks(root);
    const incomplete = tasks.filter((t) => t.status === "paused" || t.status === "blocked" || t.status === "running" || t.status === "failed");
    if (incomplete.length === 0) {
      logger.info("No paused or incomplete tasks to resume.");
      if (tasks.length > 0) {
        logger.info("Use /tasks to see all tasks, then /resume <task-id> to resume a specific one.");
      }
      return;
    }
    if (incomplete.length === 1) {
      taskId = incomplete[0].taskId;
    } else {
      logger.heading("Incomplete tasks");
      for (const t of incomplete) {
        logger.info(`  ${t.taskId} — ${t.goal} (${t.status})`);
      }
      logger.info("Use /resume <task-id> to resume a specific task.");
      return;
    }
  }

  const taskStore = await loadTaskStore(root, taskId);
  if (!taskStore) {
    logger.error(`Task not found: ${taskId}`);
    return;
  }

  const state = await taskStore.readState();
  if (!state) {
    logger.error(`Task state not found for: ${taskId}`);
    return;
  }

  if (state.status === "completed") {
    logger.info(`Task ${taskId} is already completed.`);
    return;
  }

  const plan = await taskStore.readPlan();
  const context = await collectProjectContext(root, config, plan.goal);
  const normalizedPlan = normalizeTaskPlanForContext(plan, context);
  if (JSON.stringify(normalizedPlan) !== JSON.stringify(plan)) {
    await taskStore.writePlan(normalizedPlan);
  }
  const resumeIndex = resolveResumeStepIndex(normalizedPlan, state);
  logger.heading(`Resuming task: ${normalizedPlan.goal}`);
  if (state.lastFailure) {
    logger.warn(`Last stop: ${state.lastFailure.summary}`);
    logger.info(`Next action: ${state.lastFailure.nextAction}`);
  }
  logger.info(`Continuing from step ${Math.min(resumeIndex + 1, normalizedPlan.steps.length)}/${normalizedPlan.steps.length}`);

  await runComplexTask({
    root,
    config,
    provider,
    plan: normalizedPlan,
    state: { ...state, currentStepIndex: resumeIndex, status: "running" },
    store: taskStore,
    history,
    runStore: store
  });
}

function summarizePlanMode(goal: string | undefined, messages: ChatMessage[]): string {
  const transcript = messages
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n");
  return [
    goal ? `Initial goal: ${goal}` : "Initial goal: (not specified)",
    "",
    "Plan-mode discussion:",
    transcript || "(empty)"
  ].join("\n");
}

async function exitPlanMode(
  planMode: PlanModeState | undefined,
  history: ChatMessage[],
  store: import("../state/run-store.js").RunStore
): Promise<undefined | PlanModeState> {
  if (!planMode) {
    logger.info("Plan mode is not active.");
    return undefined;
  }
  const summary = summarizePlanMode(planMode.goal, planMode.messages);
  history.push({ role: "assistant", content: `已退出计划模式。\n${summary}` });
  await store.writeJson("transcript.json", history);
  logger.info("Exited plan mode.");
  return undefined;
}

async function handlePlanModeReply(
  root: string,
  config: import("../types.js").RuntimeConfig,
  provider: import("../llm/provider.js").LlmProvider,
  planMode: PlanModeState,
  message: string
): Promise<string> {
  planMode.messages.push({ role: "user", content: message });
  if (!planMode.goal) {
    planMode.goal = message;
  }

  const context = await withProgress("Collecting project context", () => collectProjectContext(root, config, planMode.goal));
  const reply = await withProgress("Discussing plan", () => generateChatReply({
    provider,
    model: config.model,
    message: [
      "We are in plan mode. Discuss requirements, clarify tradeoffs, and refine an implementation plan.",
      "Do not claim to edit files, run commands, classify intent, or execute the task.",
      "",
      message
    ].join("\n"),
    history: planMode.messages,
    context
  }));
  planMode.messages.push({ role: "assistant", content: reply });
  planMode.lastSummary = summarizePlanMode(planMode.goal, planMode.messages);
  logger.heading("assistant");
  logger.info(reply);
  return reply;
}

async function handleApplyPlanCommand(
  root: string,
  config: import("../types.js").RuntimeConfig,
  provider: import("../llm/provider.js").LlmProvider,
  planMode: PlanModeState,
  history: ChatMessage[],
  runStore: import("../state/run-store.js").RunStore
): Promise<void> {
  const summary = summarizePlanMode(planMode.goal, planMode.messages);
  planMode.lastSummary = summary;
  const goal = planMode.goal ?? "Apply the discussed plan";
  const planningGoal = [
    goal,
    "",
    "Use this plan-mode discussion as the source of requirements:",
    summary
  ].join("\n");
  const context = await withProgress("Collecting project context", () => collectProjectContext(root, config, goal));
  let plan: TaskPlan;
  try {
    plan = await withProgress("Generating task plan", () => generateTaskPlan({
      provider,
      model: config.model,
      goal: planningGoal,
      context
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to generate task plan: ${message}`);
    history.push({ role: "assistant", content: `计划转任务失败：${message}` });
    return;
  }

  const taskStore = await createTaskStore(root, plan.goal || goal);
  const taskState: TaskState = {
    taskId: taskStore.taskId,
    status: "ready",
    currentStepIndex: 0,
    completedSteps: [],
    knownFailures: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  history.push({ role: "user", content: "/apply-plan" });
  history.push({ role: "assistant", content: `已将计划讨论转换为任务计划：${plan.goal}` });
  await runComplexTask({
    root,
    config,
    provider,
    plan,
    state: taskState,
    store: taskStore,
    history,
    runStore
  });
}

async function runComplexTask(params: {
  root: string;
  config: import("../types.js").RuntimeConfig;
  provider: import("../llm/provider.js").LlmProvider;
  plan: TaskPlan;
  state: TaskState;
  store: import("../state/task-store.js").TaskStore;
  history: ChatMessage[];
  runStore: import("../state/run-store.js").RunStore;
}): Promise<void> {
  const { root, config, provider, plan, state, store, history, runStore } = params;
  const totalSteps = plan.steps.length;

  logger.heading("Task plan");
  for (const step of plan.steps) {
    const milestone = step.milestone === true ? " [milestone]" : "";
    logger.info(`  [${step.id}] ${step.title}${milestone}`);
  }
  logger.info("");

  await store.writePlan(plan);
  await store.writeState({ ...state, status: "ready" });

  const shouldStart = config.autoApply || await askConfirm("Execute this plan step by step?", true);
  if (!shouldStart) {
    logger.info("Plan saved. Use /resume to execute later.");
    history.push({ role: "assistant", content: `计划已保存：${plan.goal}。稍后可用 /resume 继续执行。` });
    return;
  }

  const generator = executeTask({ root, config, provider, plan, state, store, patchArtifactDir: runStore.dir });

  try {
    for await (const event of generator) {
      switch (event.kind) {
        case "step_started": {
          logger.heading(`[${event.stepId}/${totalSteps}] ${event.stepTitle}`);
          break;
        }
        case "step_code_plan": {
          logger.info(`Plan: ${event.summary}`);
          break;
        }
        case "step_patch": {
          printPatchPreview(event.patchName, event.patch);
          break;
        }
        case "step_files_written": {
          logger.success(`Files: ${event.files.join(", ")}`);
          break;
        }
        case "step_verification": {
          if (event.results.length > 0) {
            for (const r of event.results) {
              const icon = r.exitCode === 0 ? "✓" : "✗";
              logger.info(`${icon} ${r.command} (${r.durationMs}ms)`);
            }
          }
          break;
        }
        case "step_repair": {
          logger.warn(`Repair attempt ${event.attempt}/${event.maxAttempts}...`);
          break;
        }
        case "step_environment_issue": {
          logger.warn(`Environment issue: ${event.message}`);
          break;
        }
        case "step_command_deferred": {
          logger.warn(`Command requires confirmation: ${event.command}`);
          logger.info(event.reason);
          break;
        }
        case "step_completed": {
          const icon = event.result.verificationResult === "passed" ? "✅"
            : event.result.verificationResult === "failed" ? "❌"
            : "⏭️";
          logger.info(`${icon} Step ${event.result.stepId} complete: ${event.result.summary}`);
          if (event.result.semanticWarnings?.length) {
            logger.warn(`Semantic warnings: ${event.result.semanticWarnings.join("; ")}`);
          }
          break;
        }
        case "milestone": {
          logger.heading("Milestone reached");
          logger.info(event.progress);
          const shouldContinue = config.autoApply || await askConfirm("Continue to next steps?", true);
          if (!shouldContinue) {
            logger.info("Task paused. Use /resume to continue.");
            history.push({ role: "assistant", content: `任务已暂停在步骤 ${event.stepIndex + 1}/${totalSteps}。使用 /resume 继续。` });
            return;
          }
          // Resume by creating a new generator with updated state
          const updatedState = await store.readState();
          if (!updatedState) return;
          const nextGenerator = executeTask({
            root, config, provider, plan,
            state: { ...updatedState, currentStepIndex: resolveResumeStepIndex(plan, updatedState), status: "running" },
            store,
            patchArtifactDir: runStore.dir
          });
          // Continue processing events from the new generator
          // We use a nested loop with a flag
          await continueTaskExecution(nextGenerator, root, config, provider, plan, store, history, runStore.dir);
          return;
        }
        case "paused": {
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
            logger.info(`Use /resume ${event.state.taskId} after resolving it.`);
          }
          history.push({ role: "assistant", content: `任务暂停：${event.reason}` });
          return;
        }
        case "completed": {
          logger.success(`Task completed: ${state.completedSteps.filter((s) => s.verificationResult === "passed").length}/${totalSteps} steps passed`);
          history.push({ role: "assistant", content: `任务完成：${plan.goal}。共完成 ${state.completedSteps.length} 个步骤。` });
          return;
        }
        case "failed": {
          logger.error(`Task failed: ${event.error}`);
          history.push({ role: "assistant", content: `任务失败：${event.error}` });
          return;
        }
      }
    }
  } finally {
    // Clean up generator if needed
  }
}

async function continueTaskExecution(
  generator: AsyncGenerator<ExecutorEvent>,
  root: string,
  config: import("../types.js").RuntimeConfig,
  provider: import("../llm/provider.js").LlmProvider,
  plan: TaskPlan,
  store: import("../state/task-store.js").TaskStore,
  history: ChatMessage[],
  patchArtifactDir?: string
): Promise<void> {
  const totalSteps = plan.steps.length;
  for await (const event of generator) {
    switch (event.kind) {
      case "step_started":
        logger.heading(`[${event.stepId}/${totalSteps}] ${event.stepTitle}`);
        break;
      case "step_code_plan":
        logger.info(`Plan: ${event.summary}`);
        break;
      case "step_patch":
        printPatchPreview(event.patchName, event.patch);
        break;
      case "step_files_written":
        logger.success(`Files: ${event.files.join(", ")}`);
        break;
      case "step_verification":
        for (const r of event.results) {
          const icon = r.exitCode === 0 ? "✓" : "✗";
          logger.info(`${icon} ${r.command} (${r.durationMs}ms)`);
        }
        break;
      case "step_repair":
        logger.warn(`Repair attempt ${event.attempt}/${event.maxAttempts}...`);
        break;
      case "step_environment_issue":
        logger.warn(`Environment issue: ${event.message}`);
        break;
      case "step_command_deferred":
        logger.warn(`Command requires confirmation: ${event.command}`);
        logger.info(event.reason);
        break;
      case "step_completed": {
        const icon = event.result.verificationResult === "passed" ? "✅"
          : event.result.verificationResult === "failed" ? "❌"
          : "⏭️";
        logger.info(`${icon} Step ${event.result.stepId} complete: ${event.result.summary}`);
        break;
      }
      case "milestone": {
        logger.heading("Milestone reached");
        logger.info(event.progress);
        const shouldContinue = config.autoApply || await askConfirm("Continue to next steps?", true);
        if (!shouldContinue) {
          logger.info("Task paused. Use /resume to continue.");
          history.push({ role: "assistant", content: `任务已暂停。使用 /resume 继续。` });
          return;
        }
        const updatedState = await store.readState();
        if (!updatedState) return;
        const nextGen = executeTask({
          root, config, provider, plan,
          state: { ...updatedState, currentStepIndex: resolveResumeStepIndex(plan, updatedState), status: "running" },
          store,
          patchArtifactDir
        });
        await continueTaskExecution(nextGen, root, config, provider, plan, store, history, patchArtifactDir);
        return;
      }
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
          logger.info(`Use /resume ${event.state.taskId} after resolving it.`);
        }
        history.push({ role: "assistant", content: `任务暂停：${event.reason}` });
        return;
      case "completed":
        logger.success("Task completed.");
        history.push({ role: "assistant", content: `任务完成：${plan.goal}` });
        return;
      case "failed":
        logger.error(`Task failed: ${event.error}`);
        history.push({ role: "assistant", content: `任务失败：${event.error}` });
        return;
    }
  }
}

async function runRepairLoop(params: {
  root: string;
  config: import("../types.js").RuntimeConfig;
  provider: import("../llm/provider.js").LlmProvider;
  history: ChatMessage[];
  runningCommands: RunningCommand[];
  task: string;
  patchArtifactDir?: string;
}): Promise<void> {
  const { root, config, provider, history, runningCommands, task, patchArtifactDir } = params;
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

      const repairErrors = validateCodeActionPlan(root, repairPlan, { requireFiles: true });
    if (repairErrors.length > 0) {
      logger.error(`Repair validation failed:\n${repairErrors.join("\n")}`);
      history.push({ role: "assistant", content: `修复校验失败：${repairErrors.join("; ")}` });
      break;
    }

    logger.heading(`Repair ${attempt + 1}/${config.maxRepairAttempts}`);
    logger.info(formatCodeActionPlan(repairPlan));
    const repairPatch = await createFileActionsPatch(root, repairPlan.files);
    printPatchPreview(`repair-${attempt + 1}.diff`, repairPatch.patch);

    if (!(config.autoApply || await askConfirm("Apply this repair?", true))) {
      logger.info("Repair skipped.");
      history.push({ role: "assistant", content: "用户跳过修复。" });
      break;
    }

    if (repairPlan.files.length > 0) {
      await applyFileActions(root, repairPlan.files, {
        artifactDir: patchArtifactDir,
        patchName: `repair-${attempt + 1}.diff`
      });
      logger.success("Repair files written.");
      history.push({ role: "assistant", content: `已修复文件：${repairPlan.files.map((f) => f.path).join(", ")}` });
    }

    const newResults: ValidationResult[] = [];
    for (const cmd of repairPlan.commands) {
      if (requiresInstallConfirmation(cmd.command)) {
        logger.info(`Skipped install command pending explicit user confirmation: ${cmd.command}`);
        history.push({ role: "assistant", content: `安装命令需要明确确认，已跳过：${cmd.command}` });
      } else if (isLongRunningCommand(cmd.command)) {
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
  let planMode: PlanModeState | undefined;
  const store = await createRunStore(root, "chat session");
  await store.writeText("task.txt", "chat session");
  await store.writeJson("transcript.json", history);

  logger.heading(`CodeShit Chat v${appVersion}`);
  logger.info("Type naturally. The CLI asks before editing files or running commands. Type /help for controls.");

  while (true) {
    let raw: string;
    try {
      const chatInput = await readChatInput(planMode !== undefined);
      if (chatInput.kind === "plan_exit_shortcut") {
        planMode = await exitPlanMode(planMode, history, store);
        continue;
      }
      raw = chatInput.value;
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
      const wasInPlanMode = planMode !== undefined;
      planMode = undefined;
      await store.writeJson("transcript.json", history);
      logger.info(wasInPlanMode ? "Conversation history cleared. Plan mode exited." : "Conversation history cleared.");
      continue;
    }
    if (parsed.kind === "plan_exit") {
      planMode = await exitPlanMode(planMode, history, store);
      continue;
    }
    if (parsed.kind === "apply_plan") {
      if (!planMode) {
        logger.warn("/apply-plan is only available in plan mode. Start with /plan.");
        continue;
      }
      if (!planMode.goal && planMode.messages.length === 0) {
        logger.warn("Plan mode has no goal or discussion yet. Describe what you want to plan first.");
        continue;
      }
      await handleApplyPlanCommand(root, config, provider, planMode, history, store);
      planMode = undefined;
      await store.writeJson("transcript.json", history);
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
    if (parsed.kind === "tasks") {
      await handleTasksCommand(root);
      continue;
    }
    if (parsed.kind === "resume") {
      await handleResumeCommand(root, parsed.taskId, config, provider, history, store);
      continue;
    }
    if (parsed.kind === "plan") {
      planMode = { goal: parsed.task, messages: [] };
      history.push({ role: "user", content: parsed.task ? `/plan ${parsed.task}` : "/plan" });
      logger.heading("Plan mode");
      logger.info("Plan mode is active. I will discuss and refine the plan only.");
      logger.info("Use /apply-plan to turn this discussion into a task plan, or press Shift+Tab to return to normal chat.");
      if (parsed.task) {
        await handlePlanModeReply(root, config, provider, planMode, parsed.task);
      } else {
        logger.info("Describe the goal you want to plan.");
      }
      await store.writeJson("transcript.json", history);
      continue;
    }
    if (parsed.kind === "unknown_command") {
      logger.warn(`Unknown chat command: ${parsed.command}`);
      logger.info("Type /help to see available chat commands.");
      continue;
    }

    runningCommands = pruneStoppedCommands(runningCommands);
    if (planMode) {
      await handlePlanModeReply(root, config, provider, planMode, parsed.message);
      await store.writeJson("transcript.json", history);
      continue;
    }
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

    if (intent.intent === "task_goal") {
      logger.heading("Task goal");
      logger.info(`Goal: ${intent.task}`);
      logger.info(`Reason: ${intent.reason}`);
      const shouldPlan = config.autoApply || await askConfirm("Create a resumable task plan for this goal?", true);
      if (!shouldPlan) {
        logger.info("No task plan created.");
        history.push({ role: "assistant", content: "用户取消了任务计划，没有执行。" });
        await store.writeJson("transcript.json", history);
        continue;
      }

      const planContext = await withProgress("Collecting project context", () => collectProjectContext(root, config, intent.task));
      let plan: TaskPlan;
      try {
        plan = await withProgress("Generating task plan", () => generateTaskPlan({
          provider,
          model: config.model,
          goal: intent.task,
          context: planContext
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.error(`Failed to generate task plan: ${message}`);
        history.push({ role: "assistant", content: `任务分解失败：${message}` });
        await store.writeJson("transcript.json", history);
        continue;
      }

      const taskStore = await createTaskStore(root, intent.task);
      const taskState: TaskState = {
        taskId: taskStore.taskId,
        status: "ready",
        currentStepIndex: 0,
        completedSteps: [],
        knownFailures: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };

      await runComplexTask({
        root,
        config,
        provider,
        plan,
        state: taskState,
        store: taskStore,
        history,
        runStore: store
      });
      await store.writeJson("transcript.json", history);
      continue;
    }

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

      // Check for complex multi-step tasks — use Task Runtime
      const shouldUseTaskRuntime = !isCreateOrScaffoldTask(intent.task) && (isTaskGoalMessage(intent.task) || isComplexTask(intent.task));
      if (shouldUseTaskRuntime) {
        logger.info("Complex task detected — using multi-step execution.");
        const planContext = await withProgress("Collecting project context", () => collectProjectContext(root, config, intent.task));
        let plan: TaskPlan | undefined;
        try {
          plan = await withProgress("Generating task plan", () => generateTaskPlan({
            provider,
            model: config.model,
            goal: intent.task,
            context: planContext
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`Failed to generate task plan: ${message}`);
          if (isTaskGoalMessage(intent.task)) {
            history.push({ role: "assistant", content: `任务分解失败：${message}` });
            await store.writeJson("transcript.json", history);
            continue;
          }
          logger.info("Falling back to single-pass file actions.");
          history.push({ role: "assistant", content: `任务分解失败，已回退到单次文件生成：${message}` });
        }

        if (plan) {
          const taskStore = await createTaskStore(root, intent.task);
          const taskState: TaskState = {
            taskId: taskStore.taskId,
            status: "ready",
            currentStepIndex: 0,
            completedSteps: [],
            knownFailures: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };

          await runComplexTask({
            root,
            config,
            provider,
            plan,
            state: taskState,
            store: taskStore,
            history,
            runStore: store
          });
          await store.writeJson("transcript.json", history);
          continue;
        }
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
      const errors = validateCodeActionPlan(root, actionPlan, { requireFiles: true });
      if (errors.length > 0) {
        logger.error(`Code action validation failed:\n${errors.join("\n")}`);
        history.push({ role: "assistant", content: `代码动作校验失败：${errors.join("; ")}` });
        await store.writeJson("transcript.json", history);
        continue;
      }
      const patchPreview = await createFileActionsPatch(root, actionPlan.files);
      printPatchPreview("patch.diff", patchPreview.patch);
      if (actionPlan.files.length > 0 && (config.autoApply || await askConfirm("Write these files now?", false))) {
        await applyFileActions(root, actionPlan.files, {
          artifactDir: store.dir,
          patchName: "patch.diff"
        });
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
      let stopFurtherCommands = false;
      for (const cmd of actionPlan.commands) {
        if (stopFurtherCommands) break;
        const isInstall = requiresInstallConfirmation(cmd.command);
        const isLongRunning = isLongRunningCommand(cmd.command);
        if (isInstall) {
          logger.info(`Skipped install command pending explicit user confirmation: ${cmd.command}`);
          history.push({ role: "assistant", content: `安装命令需要明确确认，已跳过：${cmd.command}` });
          await linkLocalTypeScriptToolchain(root);
          continue;
        }
        const message = isInstall
          ? `This looks like an install command. Run "${cmd.command}"?`
          : `Run "${cmd.command}"?`;
        if (await askConfirm(message, false)) {
          if (isLongRunning || isInstall) {
            await runChatCommand(root, cmd.command, runningCommands, history);
          } else {
            const result = await withProgress(`Running command: ${cmd.command}`, () => runValidationCommand(root, cmd.command));
            const output = formatCompactCommandResult(result);
            logger.heading("Command result");
            logger.info(output);
            history.push({ role: "assistant", content: output });
            environmentIssue = analyzeEnvironmentFailures([result]);
            if (environmentIssue) {
              let recordedEnvironmentFailure = false;
              const message = formatEnvironmentIssue(environmentIssue);
              logger.heading("Environment issue");
              logger.warn(message);
              history.push({ role: "assistant", content: message });
              stopFurtherCommands = true;

              if (shouldAttemptEnvironmentFix(environmentIssue)) {
                // Try to fix missing local tooling/configuration automatically.
                const fixContext = await withProgress("Attempting environment fix", () =>
                  collectProjectContext(root, config, result.command)
                );
                const fix = await generateEnvironmentFix({
                  provider,
                  model: config.model,
                  issue: environmentIssue,
                  context: fixContext,
                  failedCommand: result.command
                });

                if (fix && (fix.files.length > 0 || fix.commands.length > 0)) {
                  logger.heading("Generated environment fix");
                  if (fix.files.length > 0) {
                    logger.info(`Files: ${fix.files.map((f) => f.path).join(", ")}`);
                    const fixPatch = await createFileActionsPatch(root, fix.files);
                    printPatchPreview("environment-fix.diff", fixPatch.patch);
                    await applyFileActions(root, fix.files, {
                      artifactDir: store.dir,
                      patchName: "environment-fix.diff"
                    });
                    for (const f of fix.files) {
                      // Make shell scripts executable
                      if (f.path.endsWith("gradlew") || f.path.endsWith("mvnw")) {
                        try { await runValidationCommand(root, `chmod +x ${f.path}`); } catch { /* ok */ }
                      }
                    }
                  }
                  if (fix.commands.length > 0) {
                    for (const cmd of fix.commands) {
                      logger.info(`Running: ${cmd.command}`);
                      try { await runValidationCommand(root, cmd.command); } catch { /* ok */ }
                    }
                  }

                  // Retry the failed command
                  logger.info("Retrying failed command after environment fix...");
                  const retryResult = await withProgress(`Retrying: ${result.command}`, () =>
                    runValidationCommand(root, result.command)
                  );
                  const retryOutput = formatCompactCommandResult(retryResult);
                  logger.heading("Retry result");
                  logger.info(retryOutput);
                  history.push({ role: "assistant", content: `环境修复后重试：\n${retryOutput}` });

                  if (retryResult.exitCode === 0) {
                    environmentIssue = undefined;
                    stopFurtherCommands = false;
                    validationResults.push(retryResult);
                    continue; // Success — continue to next command
                  }
                  validationResults.push(retryResult);
                  recordedEnvironmentFailure = true;
                }
              } else {
                logger.info("Environment fix skipped: the service must be started before endpoint checks can run.");
              }
              if (!recordedEnvironmentFailure) {
                validationResults.push(result);
              }
              break;
            }
            validationResults.push(result);
          }
        } else {
          logger.info(`Skipped command: ${cmd.command}`);
          history.push({ role: "assistant", content: `用户跳过命令：${cmd.command}` });
          stopFurtherCommands = true;
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
          task: `Original task: ${intent.task}\n\nCommand errors:\n${errorSummary}`,
          patchArtifactDir: store.dir
        });
      }

      await store.writeJson("transcript.json", history);
      continue;
    }

    if (intent.intent === "command") {
      if (isTaskGoalMessage(parsed.message)) {
        logger.info("Composite execution goal detected — using multi-step task runtime instead of a one-shot command.");
        const planContext = await withProgress("Collecting project context", () => collectProjectContext(root, config, parsed.message));
        let plan: TaskPlan;
        try {
          plan = await withProgress("Generating task plan", () => generateTaskPlan({
            provider,
            model: config.model,
            goal: parsed.message,
            context: planContext
          }));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.error(`Failed to generate task plan: ${message}`);
          history.push({ role: "assistant", content: `任务分解失败：${message}` });
          await store.writeJson("transcript.json", history);
          continue;
        }

        const taskStore = await createTaskStore(root, parsed.message);
        const taskState: TaskState = {
          taskId: taskStore.taskId,
          status: "ready",
          currentStepIndex: 0,
          completedSteps: [],
          knownFailures: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };
        await runComplexTask({
          root,
          config,
          provider,
          plan,
          state: taskState,
          store: taskStore,
          history,
          runStore: store
        });
        await store.writeJson("transcript.json", history);
        continue;
      }
      logger.heading("Suggested command");
      logger.info(`Command: ${intent.command}`);
      logger.info(`Reason: ${intent.reason}`);
      const isInstall = requiresInstallConfirmation(intent.command);
      const isLongRunning = isLongRunningCommand(intent.command);
      if (isInstall) {
        logger.info(`Install command requires explicit confirmation: ${intent.command}`);
        history.push({ role: "assistant", content: `安装命令需要明确确认，未自动执行：${intent.command}` });
        await store.writeJson("transcript.json", history);
        continue;
      }
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
              if (isTaskGoalMessage(parsed.message)) {
                const taskStore = await createTaskStore(root, parsed.message);
                const now = new Date().toISOString();
                const taskState: TaskState = {
                  taskId: taskStore.taskId,
                  status: "blocked",
                  currentStepIndex: 0,
                  completedSteps: [],
                  knownFailures: [environmentIssue.summary],
                  blockedReason: environmentIssue.summary,
                  lastFailure: {
                    stepId: "command",
                    stepIndex: 0,
                    command: result.command,
                    exitCode: result.exitCode,
                    stdout: result.stdout,
                    stderr: result.stderr,
                    summary: environmentIssue.summary,
                    details: environmentIssue.details,
                    suggestions: environmentIssue.suggestions,
                    nextAction: `Resolve the environment issue for "${result.command}", then use /resume ${taskStore.taskId}.`,
                    occurredAt: now
                  },
                  createdAt: now,
                  updatedAt: now
                };
                await taskStore.writePlan({
                  goal: parsed.message,
                  steps: [{
                    id: "command",
                    title: `Run ${intent.command}`,
                    description: parsed.message,
                    expectedFiles: [],
                    verification: intent.command,
                    milestone: false
                  }]
                });
                await taskStore.writeState(taskState);
                logger.info(`Saved blocked task. Use /resume ${taskStore.taskId} after resolving the environment issue.`);
              }
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
                  task: repairTask,
                  patchArtifactDir: store.dir
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
