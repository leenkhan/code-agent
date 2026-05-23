import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import fs from "fs-extra";
import os from "node:os";
import { createTaskStore, listTasks, loadTaskStore } from "../src/state/task-store.js";
import type { TaskPlan, TaskState } from "../src/types.js";

describe("task-store", () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-task-store-"));
  });

  afterEach(async () => {
    await fs.remove(root);
  });

  const samplePlan: TaskPlan = {
    goal: "Add OAuth login",
    steps: [
      {
        id: "1",
        title: "Install deps",
        description: "Install oauth package",
        expectedFiles: ["package.json"],
        verification: "pnpm install",
        milestone: false
      },
      {
        id: "2",
        title: "Add route",
        description: "Create OAuth route",
        expectedFiles: ["src/auth/oauth.ts"],
        verification: "pnpm build",
        milestone: true
      }
    ]
  };

  const sampleState: TaskState = {
    taskId: "test-task",
    status: "ready",
    currentStepIndex: 0,
    completedSteps: [],
    knownFailures: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  it("creates a task store directory", async () => {
    const store = await createTaskStore(root, "Add OAuth login");
    expect(await fs.pathExists(store.dir)).toBe(true);
  });

  it("writes and reads a plan", async () => {
    const store = await createTaskStore(root, "Add OAuth login");
    await store.writePlan(samplePlan);
    const read = await store.readPlan();
    expect(read.goal).toBe("Add OAuth login");
    expect(read.steps).toHaveLength(2);
    expect(read.steps[0].id).toBe("1");
  });

  it("writes and reads state", async () => {
    const store = await createTaskStore(root, "test");
    const state = { ...sampleState, taskId: store.taskId };
    await store.writeState(state);
    const read = await store.readState();
    expect(read).toBeDefined();
    expect(read!.status).toBe("ready");
    expect(read!.currentStepIndex).toBe(0);
  });

  it("returns undefined for missing state", async () => {
    const store = await createTaskStore(root, "test");
    const state = await store.readState();
    expect(state).toBeUndefined();
  });

  it("writes step results", async () => {
    const store = await createTaskStore(root, "test");
    await store.writeStepResult(0, { result: "passed", files: ["a.ts"] });
    const stepFile = path.join(store.dir, "step-0-result.json");
    expect(await fs.pathExists(stepFile)).toBe(true);
    const data = await fs.readJson(stepFile);
    expect(data.result).toBe("passed");
  });

  it("lists tasks sorted by recency", async () => {
    const store1 = await createTaskStore(root, "Task one");
    const state1 = { ...sampleState, taskId: store1.taskId, status: "completed" as const };
    await store1.writePlan(samplePlan);
    await store1.writeState(state1);

    const store2 = await createTaskStore(root, "Task two");
    const state2 = { ...sampleState, taskId: store2.taskId, status: "paused" as const };
    await store2.writePlan(samplePlan);
    await store2.writeState(state2);

    const tasks = await listTasks(root);
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    // Most recent first
    expect(tasks[0].status).toBe("paused");
  });

  it("loads an existing task store", async () => {
    const created = await createTaskStore(root, "test");
    const state = { ...sampleState, taskId: created.taskId };
    await created.writePlan(samplePlan);
    await created.writeState(state);

    const loaded = await loadTaskStore(root, created.taskId);
    expect(loaded).toBeDefined();
    const plan = await loaded!.readPlan();
    expect(plan.goal).toBe("Add OAuth login");
  });

  it("returns undefined for non-existent task", async () => {
    const loaded = await loadTaskStore(root, "non-existent");
    expect(loaded).toBeUndefined();
  });

  it("skips corrupted task dirs in listTasks", async () => {
    const store = await createTaskStore(root, "valid");
    const state = { ...sampleState, taskId: store.taskId, status: "ready" as const };
    await store.writePlan(samplePlan);
    await store.writeState(state);

    // Create a corrupted dir without state.json
    const corruptedDir = path.join(root, ".codeshit", "tasks", "corrupted-dir");
    await fs.ensureDir(corruptedDir);

    const tasks = await listTasks(root);
    expect(tasks.length).toBe(1);
    expect(tasks[0].status).toBe("ready");
  });
});
