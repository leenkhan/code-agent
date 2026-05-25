import { execa } from "execa";
import { constants } from "node:fs";
import path from "node:path";
import fs from "fs-extra";
import type { ValidationResult } from "../types.js";
import { assertCommandAllowed } from "../safety/command-policy.js";
import { redactSecrets } from "../safety/secrets.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const FORCE_KILL_AFTER_MS = 1500;

export async function runValidationCommand(root: string, command: string): Promise<ValidationResult> {
  const runnableCommand = await normalizeLocalValidationCommand(root, command);
  assertCommandAllowed(runnableCommand);
  const started = Date.now();
  const timeoutMs = getCommandTimeoutMs();
  let timedOut = false;
  let forceKillTimer: NodeJS.Timeout | undefined;
  const subprocess = execa(runnableCommand, {
    cwd: root,
    shell: true,
    reject: false,
    all: false,
    detached: true
  });
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    terminateProcessGroup(subprocess.pid, subprocess.kill.bind(subprocess), "SIGTERM");
    forceKillTimer = setTimeout(() => {
      terminateProcessGroup(subprocess.pid, subprocess.kill.bind(subprocess), "SIGKILL");
    }, FORCE_KILL_AFTER_MS);
    forceKillTimer.unref?.();
  }, timeoutMs);
  timeoutTimer.unref?.();

  try {
    const result = await subprocess;
    clearTimeout(timeoutTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    if (timedOut) return buildTimeoutResult(command, result.stdout, result.stderr, started, timeoutMs);
    return {
      command,
      exitCode: result.exitCode ?? 0,
      stdout: redactSecrets(result.stdout),
      stderr: redactSecrets(result.stderr),
      durationMs: Date.now() - started
    };
  } catch (error) {
    clearTimeout(timeoutTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    if (timedOut) {
      const output = readCommandOutput(error);
      return buildTimeoutResult(command, output.stdout, output.stderr, started, timeoutMs);
    }
    const message = error instanceof Error ? error.message : String(error);
    return {
      command,
      exitCode: 1,
      stdout: "",
      stderr: redactSecrets(message),
      durationMs: Date.now() - started
    };
  }
}

function getCommandTimeoutMs(): number {
  const configured = Number(process.env.CODE_AGENT_COMMAND_TIMEOUT_MS);
  if (Number.isFinite(configured) && configured > 0) return configured;
  return DEFAULT_COMMAND_TIMEOUT_MS;
}

function terminateProcessGroup(pid: number | undefined, kill: (signal?: NodeJS.Signals | number) => boolean, signal: NodeJS.Signals): void {
  if (!pid) {
    try { kill(signal); } catch { /* best effort */ }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try { kill(signal); } catch { /* best effort */ }
  }
}

function buildTimeoutResult(command: string, stdout: string | undefined, stderr: string | undefined, started: number, timeoutMs: number): ValidationResult {
  const message = `Command timed out after ${timeoutMs}ms and was terminated. Set CODE_AGENT_COMMAND_TIMEOUT_MS to adjust this limit.`;
  const combinedStderr = [message, stderr].filter(Boolean).join("\n");
  return {
    command,
    exitCode: 124,
    stdout: redactSecrets(stdout ?? ""),
    stderr: redactSecrets(combinedStderr),
    durationMs: Date.now() - started
  };
}

function readCommandOutput(error: unknown): { stdout?: string; stderr?: string } {
  if (!error || typeof error !== "object") return {};
  const record = error as { stdout?: unknown; stderr?: unknown };
  return {
    stdout: typeof record.stdout === "string" ? record.stdout : undefined,
    stderr: typeof record.stderr === "string" ? record.stderr : undefined
  };
}

async function normalizeLocalValidationCommand(root: string, command: string): Promise<string> {
  const pythonCommand = await normalizePythonValidationCommand(command);
  if (!/^npx\s+tsc\b/.test(pythonCommand.trim())) return pythonCommand;
  const localProjectTsc = path.join(root, "node_modules", ".bin", "tsc");
  if (await fs.pathExists(localProjectTsc)) return pythonCommand;

  const agentTsc = path.resolve(process.cwd(), "node_modules", ".bin", "tsc");
  if (await fs.pathExists(agentTsc)) {
    const agentTypes = path.resolve(process.cwd(), "node_modules", "@types");
    const extraArgs = await fs.pathExists(agentTypes) ? ` --typeRoots "${agentTypes}"` : "";
    return `"${agentTsc}"${pythonCommand.trim().replace(/^npx\s+tsc\b/, "")}${extraArgs}`;
  }
  return pythonCommand;
}

async function normalizePythonValidationCommand(command: string): Promise<string> {
  if (!/(^|[;&|()]\s*)python(?=\s|$)/.test(command)) return command;
  if (await commandExistsOnPath("python")) return command;
  if (!await commandExistsOnPath("python3")) return command;
  return command.replace(/(^|[;&|()]\s*)python(?=\s|$)/g, "$1python3");
}

async function commandExistsOnPath(command: string): Promise<boolean> {
  const searchPath = process.env.PATH ?? "";
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    try {
      await fs.access(path.join(directory, command), constants.X_OK);
      return true;
    } catch {
      // Keep scanning PATH.
    }
  }
  return false;
}
