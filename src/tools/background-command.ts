import { spawn, type ChildProcess } from "node:child_process";
import { assertCommandAllowed } from "../safety/command-policy.js";
import { redactSecrets } from "../safety/secrets.js";
import { compactOutput } from "../ui/command-output.js";

export type RunningCommand = {
  id: number;
  command: string;
  process: ChildProcess;
  startedAt: Date;
  stopped?: boolean;
};

const longRunningPatterns = [
  /\buvicorn\b.*--reload/i,
  /\buvicorn\b.*--host/i,
  /\bfastapi\s+dev\b/i,
  /\bnpm\s+run\s+dev\b/i,
  /\bpnpm\s+dev\b/i,
  /\byarn\s+dev\b/i,
  /\bnext\s+dev\b/i,
  /\bvite\b/i
];

let nextId = 1;

export function isLongRunningCommand(command: string): boolean {
  return longRunningPatterns.some((pattern) => pattern.test(command));
}

export function startBackgroundCommand(root: string, command: string): RunningCommand {
  assertCommandAllowed(command);
  const child = spawn(command, {
    cwd: root,
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    detached: true
  });
  const running: RunningCommand = {
    id: nextId,
    command,
    process: child,
    startedAt: new Date()
  };
  nextId += 1;

  child.stdout?.on("data", (chunk: Buffer) => {
    const output = compactOutput(redactSecrets(chunk.toString()), { maxLines: 3 });
    if (output.trim()) {
      process.stdout.write(`\n[${running.id}] ${output}`);
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    const output = compactOutput(redactSecrets(chunk.toString()), { maxLines: 3 });
    if (output.trim()) {
      process.stderr.write(`\n[${running.id}] ${output}`);
    }
  });

  return running;
}

export async function stopBackgroundCommand(running: RunningCommand): Promise<void> {
  if (running.stopped || running.process.exitCode !== null || running.process.killed) {
    return;
  }
  const pid = running.process.pid;
  if (pid) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      running.process.kill("SIGTERM");
    }
  } else {
    running.process.kill("SIGTERM");
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      if (running.process.exitCode === null && !running.process.killed && pid) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          running.process.kill("SIGKILL");
        }
      } else if (running.process.exitCode === null && !running.process.killed) {
        running.process.kill("SIGKILL");
      }
      resolve();
    }, 1500);
    running.process.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  running.stopped = true;
}

export async function stopBackgroundCommands(commands: RunningCommand[]): Promise<number> {
  const active = commands.filter((command) => !command.stopped && command.process.exitCode === null && !command.process.killed);
  await Promise.all(active.map((command) => stopBackgroundCommand(command)));
  return active.length;
}

export function parseStopBackgroundCommand(command: string): number | "all" | undefined {
  const trimmed = command.trim();
  if (trimmed === "code-agent stop-background all") return "all";
  const match = trimmed.match(/^code-agent\s+stop-background\s+(\d+)$/);
  return match ? Number(match[1]) : undefined;
}

export async function stopBackgroundCommandById(commands: RunningCommand[], id: number): Promise<boolean> {
  const running = commands.find((command) => command.id === id && !command.stopped && command.process.exitCode === null && !command.process.killed);
  if (!running) return false;
  await stopBackgroundCommand(running);
  return true;
}

export function pruneStoppedCommands(commands: RunningCommand[]): RunningCommand[] {
  return commands.filter((command) => !command.stopped && command.process.exitCode === null && !command.process.killed);
}
