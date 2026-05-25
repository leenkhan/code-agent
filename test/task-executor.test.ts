import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeTask, resolveResumeStepIndex } from "../src/agent/task-executor.js";
import { createTaskStore } from "../src/state/task-store.js";
import type { LlmProvider } from "../src/llm/provider.js";
import type { RuntimeConfig, TaskPlan, TaskState } from "../src/types.js";
import { generateCodeActionPlan, generateEnvironmentFix } from "../src/agent/actions.js";
import { runValidationCommand } from "../src/tools/run-command.js";

vi.mock("../src/project/context.js", () => ({
  collectProjectContext: vi.fn().mockResolvedValue({
    root: "/tmp/test",
    fileTree: [],
    importantFiles: []
  })
}));

vi.mock("../src/agent/actions.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent/actions.js")>("../src/agent/actions.js");
  return {
    ...actual,
    generateCodeActionPlan: vi.fn().mockResolvedValue({
      summary: "Run Gradle tests",
      files: [],
      commands: [{ command: "./gradlew test", reason: "Verify project" }]
    }),
    generateEnvironmentFix: vi.fn().mockResolvedValue(null),
    applyFileActions: vi.fn().mockResolvedValue(undefined)
  };
});

vi.mock("../src/tools/run-command.js", () => ({
  runValidationCommand: vi.fn().mockImplementation(async (_root: string, command: string) => ({
    command,
    exitCode: 127,
    stdout: "",
    stderr: "/bin/sh: ./gradlew: No such file or directory",
    durationMs: 12
  }))
}));

function makeConfig(): RuntimeConfig {
  return {
    provider: "deepseek",
    apiKey: "test",
    model: "test-model",
    autoApply: true,
    maxRepairAttempts: 1,
    validationCommands: [],
    ignore: []
  };
}

function makeState(taskId: string, status: TaskState["status"] = "ready"): TaskState {
  return {
    taskId,
    status,
    currentStepIndex: 0,
    completedSteps: [],
    knownFailures: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

const provider: LlmProvider = {
  async generateText() {
    return "summary";
  }
};

describe("task executor state machine", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await fs.remove(root);
    root = undefined;
    vi.clearAllMocks();
  });

  it("blocks on missing environment tools without completing the step", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-task-executor-"));
    const store = await createTaskStore(root, "启动服务并完成测试");
    const plan: TaskPlan = {
      goal: "启动服务并完成测试",
      steps: [{
        id: "1",
        title: "Run tests",
        description: "Run Gradle tests",
        expectedFiles: [],
        verification: "./gradlew test",
        milestone: false
      }]
    };
    const state = makeState(store.taskId);
    await store.writePlan(plan);
    await store.writeState(state);

    const events = [];
    for await (const event of executeTask({ root, config: makeConfig(), provider, plan, state, store })) {
      events.push(event.kind);
    }

    const saved = await store.readState();
    expect(events).toContain("step_environment_issue");
    expect(events).toContain("paused");
    expect(saved?.status).toBe("blocked");
    expect(saved?.currentStepIndex).toBe(0);
    expect(saved?.completedSteps).toHaveLength(0);
    expect(saved?.blockedReason).toContain("local development environment");
    expect(saved?.lastFailure?.command).toBe("./gradlew test");
    expect(saved?.lastFailure?.exitCode).toBe(127);
  });

  it("does not generate an environment patch for a missing python command", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-task-executor-"));
    const store = await createTaskStore(root, "验证 Python API");
    const command = "cd backserve && python -c \"print('ok')\"";
    const plan: TaskPlan = {
      goal: "验证 Python API",
      steps: [{
        id: "1",
        title: "Verify API",
        description: "Run a FastAPI smoke test",
        expectedFiles: [],
        verification: command,
        milestone: false
      }]
    };
    const state = makeState(store.taskId);
    await store.writePlan(plan);
    await store.writeState(state);
    vi.mocked(runValidationCommand).mockResolvedValueOnce({
      command,
      exitCode: 127,
      stdout: "",
      stderr: "/bin/sh: python: command not found",
      durationMs: 12
    });

    const events = [];
    for await (const event of executeTask({ root, config: makeConfig(), provider, plan, state, store })) {
      events.push(event.kind);
    }

    const saved = await store.readState();
    expect(events).toContain("step_environment_issue");
    expect(events).toContain("paused");
    expect(generateEnvironmentFix).not.toHaveBeenCalled();
    expect(saved?.status).toBe("blocked");
    expect(saved?.lastFailure?.command).toBe(command);
  });

  it("does not generate files for operational verification steps even when planner lists expected files", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-task-executor-"));
    const store = await createTaskStore(root, "启动服务并完成测试");
    const plan: TaskPlan = {
      goal: "启动服务并完成测试",
      steps: [{
        id: "1",
        title: "构建项目",
        description: "运行构建验证项目是否可编译",
        expectedFiles: ["build.gradle.kts", "src/main/kotlin/com/example/demo/DemoApplication.kt"],
        verification: "./gradlew build -x test",
        milestone: false
      }]
    };
    const state = makeState(store.taskId);
    await store.writePlan(plan);
    await store.writeState(state);

    const events = [];
    for await (const event of executeTask({ root, config: makeConfig(), provider, plan, state, store })) {
      events.push(event.kind);
    }

    const saved = await store.readState();
    expect(generateCodeActionPlan).not.toHaveBeenCalled();
    expect(events).not.toContain("step_files_written");
    expect(saved?.completedSteps).toHaveLength(0);
    expect(saved?.lastFailure?.command).toBe("./gradlew build -x test");
  });

  it("treats a command as passed when an environment fix retry succeeds", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-task-executor-"));
    const store = await createTaskStore(root, "修复 wrapper 后构建");
    const plan: TaskPlan = {
      goal: "修复 wrapper 后构建",
      steps: [{
        id: "1",
        title: "Compile",
        description: "Compile project",
        expectedFiles: [],
        verification: "./gradlew compile",
        milestone: false
      }]
    };
    const state = makeState(store.taskId);
    await store.writePlan(plan);
    await store.writeState(state);

    vi.mocked(generateEnvironmentFix).mockResolvedValueOnce({
      files: [{ path: "gradlew", content: "#!/usr/bin/env sh\n" }],
      commands: []
    });
    vi.mocked(runValidationCommand)
      .mockResolvedValueOnce({
        command: "./gradlew compile",
        exitCode: 1,
        stdout: "",
        stderr: "Error: Invalid or corrupt jarfile ./.gradle/wrapper/gradle-wrapper.jar",
        durationMs: 12
      })
      .mockResolvedValueOnce({
        command: "chmod +x gradlew",
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 2
      })
      .mockResolvedValueOnce({
        command: "./gradlew compile",
        exitCode: 0,
        stdout: "BUILD SUCCESS",
        stderr: "",
        durationMs: 20
      });

    const events = [];
    for await (const event of executeTask({ root, config: makeConfig(), provider, plan, state, store })) {
      events.push(event.kind);
    }

    const saved = await store.readState();
    expect(events).toContain("step_environment_issue");
    expect(events).toContain("step_completed");
    expect(events).not.toContain("step_repair");
    expect(saved?.completedSteps[0]?.verificationResult).toBe("passed");
  });

  it("resumes blocked tasks from the failed step, not the next step", () => {
    const plan: TaskPlan = {
      goal: "verify",
      steps: [
        { id: "1", title: "Build", description: "Build", expectedFiles: [], verification: "pnpm build" },
        { id: "2", title: "Test", description: "Test", expectedFiles: [], verification: "pnpm test" }
      ]
    };
    const state = makeState("t1", "blocked");
    state.currentStepIndex = 0;
    state.lastFailure = {
      stepId: "1",
      stepIndex: 0,
      command: "pnpm build",
      exitCode: 1,
      summary: "Build failed",
      details: ["pnpm build exited 1"],
      suggestions: ["Fix build"],
      nextAction: "Fix build and resume",
      occurredAt: new Date().toISOString()
    };

    expect(resolveResumeStepIndex(plan, state)).toBe(0);
  });

  it("resumes after a completed milestone by advancing to the next incomplete step", () => {
    const plan: TaskPlan = {
      goal: "feature",
      steps: [
        { id: "1", title: "Auth", description: "Auth", expectedFiles: [], verification: "pnpm build", milestone: true },
        { id: "2", title: "Tests", description: "Tests", expectedFiles: [], verification: "pnpm test" }
      ]
    };
    const state = makeState("t1", "paused");
    state.completedSteps.push({
      stepId: "1",
      title: "Auth",
      summary: "Auth done",
      filesChanged: ["src/auth.ts"],
      verificationResult: "passed"
    });

    expect(resolveResumeStepIndex(plan, state)).toBe(1);
  });

  it("asks for confirmation before applying generated file patches", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-task-executor-"));
    const store = await createTaskStore(root, "add readme");
    const plan: TaskPlan = {
      goal: "add readme",
      steps: [{
        id: "1",
        title: "Write README",
        description: "Create README",
        expectedFiles: ["README.md"],
        verification: "",
        milestone: false
      }]
    };
    const state = makeState(store.taskId);
    await store.writePlan(plan);
    await store.writeState(state);
    vi.mocked(generateCodeActionPlan).mockResolvedValueOnce({
      summary: "Create README",
      files: [{ path: "README.md", content: "# Demo\n" }],
      commands: []
    });

    const confirmations: string[] = [];
    const events = [];
    for await (const event of executeTask({
      root,
      config: { ...makeConfig(), autoApply: false },
      provider,
      plan,
      state,
      store,
      confirm: async (confirmation) => {
        confirmations.push(confirmation.kind);
        return "defer";
      }
    })) {
      events.push(event.kind);
    }

    expect(confirmations).toEqual(["apply_patch"]);
    expect(events).toContain("step_patch");
    expect(events).toContain("paused");
    await expect(fs.pathExists(path.join(root, "README.md"))).resolves.toBe(false);
  });

  it("asks for confirmation before running validation commands", async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-task-executor-"));
    const store = await createTaskStore(root, "verify");
    const plan: TaskPlan = {
      goal: "verify",
      steps: [{
        id: "1",
        title: "Run tests",
        description: "Run tests",
        expectedFiles: [],
        verification: "pnpm test",
        milestone: false
      }]
    };
    const state = makeState(store.taskId);
    await store.writePlan(plan);
    await store.writeState(state);

    const confirmations: string[] = [];
    const events = [];
    for await (const event of executeTask({
      root,
      config: { ...makeConfig(), autoApply: false },
      provider,
      plan,
      state,
      store,
      confirm: async (confirmation) => {
        confirmations.push(confirmation.kind);
        return "defer";
      }
    })) {
      events.push(event.kind);
    }

    expect(confirmations).toEqual(["run_command"]);
    expect(runValidationCommand).not.toHaveBeenCalled();
    expect(events).toContain("paused");
  });
});
