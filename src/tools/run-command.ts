import { execa } from "execa";
import path from "node:path";
import fs from "fs-extra";
import type { ValidationResult } from "../types.js";
import { assertCommandAllowed } from "../safety/command-policy.js";
import { redactSecrets } from "../safety/secrets.js";

export async function runValidationCommand(root: string, command: string): Promise<ValidationResult> {
  const runnableCommand = await normalizeLocalValidationCommand(root, command);
  assertCommandAllowed(runnableCommand);
  const started = Date.now();
  try {
    const result = await execa(runnableCommand, { cwd: root, shell: true, reject: false, all: false });
    return {
      command,
      exitCode: result.exitCode ?? 0,
      stdout: redactSecrets(result.stdout),
      stderr: redactSecrets(result.stderr),
      durationMs: Date.now() - started
    };
  } catch (error) {
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

async function normalizeLocalValidationCommand(root: string, command: string): Promise<string> {
  if (!/^npx\s+tsc\b/.test(command.trim())) return command;
  const localProjectTsc = path.join(root, "node_modules", ".bin", "tsc");
  if (await fs.pathExists(localProjectTsc)) return command;

  const agentTsc = path.resolve(process.cwd(), "node_modules", ".bin", "tsc");
  if (await fs.pathExists(agentTsc)) {
    const agentTypes = path.resolve(process.cwd(), "node_modules", "@types");
    const extraArgs = await fs.pathExists(agentTypes) ? ` --typeRoots "${agentTypes}"` : "";
    return `"${agentTsc}"${command.trim().replace(/^npx\s+tsc\b/, "")}${extraArgs}`;
  }
  return command;
}
