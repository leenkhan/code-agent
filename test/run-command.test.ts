import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runValidationCommand } from "../src/tools/run-command.js";

const originalPath = process.env.PATH;
const originalCommandTimeout = process.env.CODE_AGENT_COMMAND_TIMEOUT_MS;

afterEach(() => {
  process.env.PATH = originalPath;
  if (originalCommandTimeout === undefined) {
    delete process.env.CODE_AGENT_COMMAND_TIMEOUT_MS;
  } else {
    process.env.CODE_AGENT_COMMAND_TIMEOUT_MS = originalCommandTimeout;
  }
});

describe("runValidationCommand", () => {
  it("uses python3 for validation commands when python is not on PATH", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-run-command-"));
    const bin = path.join(root, "bin");
    const workdir = path.join(root, "backserve");
    await fs.mkdir(bin, { recursive: true });
    await fs.mkdir(workdir, { recursive: true });
    const python3 = path.join(bin, "python3");
    await fs.writeFile(python3, "#!/bin/sh\nprintf 'python3 fallback:%s:%s\\n' \"$PWD\" \"$*\"\n", "utf8");
    await fs.chmod(python3, 0o755);
    process.env.PATH = bin;

    const result = await runValidationCommand(root, "cd backserve && python -c \"print('ok')\"");

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("python3 fallback:");
    expect(result.stdout).toContain(`${path.join(root, "backserve")}:`);
    expect(result.stdout).toContain("-c print('ok')");
  });

  it("terminates validation commands that exceed the configured timeout", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-run-command-"));
    process.env.CODE_AGENT_COMMAND_TIMEOUT_MS = "100";

    const result = await runValidationCommand(root, "node -e \"setTimeout(() => {}, 5000)\"");

    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain("Command timed out after 100ms");
    expect(result.durationMs).toBeLessThan(3000);
  });
});
