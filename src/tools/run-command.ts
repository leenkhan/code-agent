import { execa } from "execa";
import type { ValidationResult } from "../types.js";
import { assertCommandAllowed } from "../safety/command-policy.js";
import { redactSecrets } from "../safety/secrets.js";

export async function runValidationCommand(root: string, command: string): Promise<ValidationResult> {
  assertCommandAllowed(command);
  const started = Date.now();
  try {
    const result = await execa(command, { cwd: root, shell: true, reject: false, all: false });
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
