import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, afterEach } from "vitest";
import type { LlmProvider } from "../src/llm/provider.js";

const { mockStore } = vi.hoisted(() => ({
  mockStore: {
    dir: "/tmp/mock-run",
    writeText: vi.fn().mockResolvedValue(undefined),
    writeJson: vi.fn().mockResolvedValue(undefined)
  }
}));

vi.mock("../src/state/run-store.js", () => ({
  createRunStore: vi.fn().mockResolvedValue(mockStore),
  saveInitialArtifacts: vi.fn().mockResolvedValue(undefined),
  saveResult: vi.fn().mockResolvedValue(undefined),
  runsDir: vi.fn().mockReturnValue("/tmp/runs")
}));

vi.mock("../src/project/context.js", () => ({
  collectProjectContext: vi.fn().mockResolvedValue({
    root: "/tmp/test",
    fileTree: ["src/index.ts"],
    importantFiles: [],
    gitStatus: "",
    gitDiff: ""
  })
}));

vi.mock("../src/ui/confirm.js", () => ({
  askConfirm: vi.fn().mockResolvedValue(true)
}));

vi.mock("../src/patch/validate.js", () => ({
  validatePatch: vi.fn().mockReturnValue({ ok: true, errors: [], files: ["src/index.ts"] })
}));

vi.mock("../src/patch/apply.js", () => ({
  checkPatchApplies: vi.fn().mockResolvedValue({ ok: true }),
  applyPatch: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("../src/tools/git.js", () => ({
  gitDiff: vi.fn().mockResolvedValue(""),
  gitStatus: vi.fn().mockResolvedValue(""),
  isGitRepo: vi.fn().mockResolvedValue(true)
}));

vi.mock("../src/tools/run-command.js", () => ({
  runValidationCommand: vi.fn().mockResolvedValue({
    command: "pnpm test",
    exitCode: 0,
    stdout: "all passed",
    stderr: "",
    durationMs: 100
  })
}));

vi.mock("../src/project/detect.js", () => ({
  detectValidationCommands: vi.fn().mockResolvedValue(["pnpm test"]),
  importantFileGlobs: ["package.json"]
}));

import { executeRun, executeFix, runValidation } from "../src/agent/runtime.js";
import { askConfirm } from "../src/ui/confirm.js";
import { validatePatch } from "../src/patch/validate.js";
import { runValidationCommand } from "../src/tools/run-command.js";
import { checkPatchApplies } from "../src/patch/apply.js";

function makeProvider(plan = "plan", patch = "diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-old\n+new\n", repair = "diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1 +1 @@\n-broken\n+fixed\n"): LlmProvider {
  let callCount = 0;
  return {
    async generateText(_input) {
      callCount += 1;
      if (callCount === 1) return plan;
      if (callCount === 2) return patch;
      return repair;
    }
  };
}

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    provider: "deepseek" as const,
    apiKey: "test-key",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-v4-pro",
    autoApply: true,
    maxRepairAttempts: 3,
    validationCommands: [],
    ignore: [],
    ...overrides
  };
}

describe("executeRun", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("completes success path (plan → patch → apply → validate → success)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-runtime-"));
    const provider = makeProvider();
    const config = makeConfig({ validationCommands: ["pnpm test"] });

    const result = await executeRun({
      root,
      task: "fix bug",
      config,
      provider
    });

    expect(result.status).toBe("success");
    expect(result.patchApplied).toBe(true);
    expect(result.validationPassed).toBe(true);
    expect(result.repairAttempts).toBe(0);
  });

  it("returns failed when patch validation fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-runtime-"));
    const provider = makeProvider();
    const config = makeConfig();
    vi.mocked(validatePatch).mockReturnValueOnce({ ok: false, errors: ["bad patch"], files: [] });

    const result = await executeRun({
      root,
      task: "fix bug",
      config,
      provider
    });

    expect(result.status).toBe("failed");
    expect(result.patchApplied).toBe(false);
  });

  it("returns failed when git apply check fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-runtime-"));
    const provider = makeProvider();
    const config = makeConfig();
    vi.mocked(checkPatchApplies).mockResolvedValueOnce({ ok: false, error: "patch does not apply" });

    const result = await executeRun({
      root,
      task: "fix bug",
      config,
      provider
    });

    expect(result.status).toBe("failed");
    expect(result.patchApplied).toBe(false);
  });

  it("enters repair loop when validation fails and repair succeeds", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-runtime-"));
    const provider = makeProvider();
    const config = makeConfig({ validationCommands: ["pnpm test"] });

    let validationCalls = 0;
    vi.mocked(runValidationCommand).mockImplementation(async () => {
      validationCalls += 1;
      return {
        command: "pnpm test",
        exitCode: validationCalls === 1 ? 1 : 0,
        stdout: validationCalls === 1 ? "FAILED" : "PASSED",
        stderr: "",
        durationMs: 100
      };
    });

    const result = await executeRun({
      root,
      task: "fix bug",
      config,
      provider
    });

    expect(result.status).toBe("success");
    expect(result.repairAttempts).toBe(1);
    expect(result.patchApplied).toBe(true);
    expect(result.validationPassed).toBe(true);
  });

  it("skips validation when --no-test is set", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-runtime-"));
    const provider = makeProvider();
    const config = makeConfig();

    const result = await executeRun({
      root,
      task: "fix bug",
      config,
      provider,
      noTest: true
    });

    expect(result.status).toBe("success");
    expect(result.validationPassed).toBe(true);
    expect(runValidationCommand).not.toHaveBeenCalled();
  });

  it("succeeds when no validation commands are configured", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-runtime-"));
    const provider = makeProvider();
    const config = makeConfig({ validationCommands: [] });

    const result = await executeRun({
      root,
      task: "fix bug",
      config,
      provider
    });

    expect(result.status).toBe("success");
    expect(result.validationPassed).toBe(true);
  });

  it("returns cancelled when user declines plan confirmation", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-runtime-"));
    const provider = makeProvider();
    const config = makeConfig({ autoApply: false });
    vi.mocked(askConfirm).mockResolvedValueOnce(false);

    const result = await executeRun({
      root,
      task: "fix bug",
      config,
      provider
    });

    expect(result.status).toBe("cancelled");
    expect(result.patchApplied).toBe(false);
  });

  it("returns failed when patch response starts with NEED_MORE_CONTEXT", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-runtime-"));
    const provider = makeProvider(
      "A plan",
      "NEED_MORE_CONTEXT: insufficient data"
    );
    const config = makeConfig();

    const result = await executeRun({
      root,
      task: "fix bug",
      config,
      provider
    });

    expect(result.status).toBe("failed");
  });
});

describe("executeFix", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("defaults task to fix message when none provided", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-runtime-"));
    const provider = makeProvider();
    const config = makeConfig({ validationCommands: ["pnpm test"] });

    const result = await executeFix({ root, config, provider });

    expect(result.task).toBe("Fix failing validation commands");
    expect(result.status).toBe("success");
  });

  it("uses explicit task when provided", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-runtime-"));
    const provider = makeProvider();
    const config = makeConfig({ validationCommands: ["pnpm test"] });

    const result = await executeFix({ root, config, provider, task: "fix lint errors" });

    expect(result.task).toBe("fix lint errors");
  });
});

describe("runValidation", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("runs all commands and collects results", async () => {
    vi.mocked(runValidationCommand)
      .mockResolvedValueOnce({ command: "pnpm test", exitCode: 0, stdout: "ok", stderr: "", durationMs: 50 })
      .mockResolvedValueOnce({ command: "pnpm lint", exitCode: 1, stdout: "", stderr: "error", durationMs: 75 });

    const results = await runValidation("/tmp/test", ["pnpm test", "pnpm lint"]);

    expect(results.length).toBe(2);
    expect(results[0]!.exitCode).toBe(0);
    expect(results[1]!.exitCode).toBe(1);
  });
});
