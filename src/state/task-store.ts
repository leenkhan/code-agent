import path from "node:path";
import fs from "fs-extra";
import type { TaskPlan, TaskState } from "../types.js";
import { migrateProjectState, projectStateDir } from "./paths.js";

export type TaskStore = {
  dir: string;
  taskId: string;
  writePlan(plan: TaskPlan): Promise<void>;
  readPlan(): Promise<TaskPlan>;
  writeState(state: TaskState): Promise<void>;
  readState(): Promise<TaskState | undefined>;
  writeStepResult(stepIndex: number, result: unknown): Promise<void>;
};

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36) || "task";
}

function taskTimestamp(): string {
  const now = new Date();
  const pad = (v: number): string => String(v).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function tasksDir(root: string): string {
  return path.join(projectStateDir(root), "tasks");
}

export async function createTaskStore(root: string, goal: string): Promise<TaskStore> {
  await migrateProjectState(root);
  const taskId = `${taskTimestamp()}-${slugify(goal)}`;
  const dir = path.join(tasksDir(root), taskId);
  await fs.ensureDir(dir);

  return {
    dir,
    taskId,
    async writePlan(plan) {
      await fs.writeJson(path.join(dir, "plan.json"), plan, { spaces: 2 });
    },
    async readPlan() {
      return fs.readJson(path.join(dir, "plan.json")) as Promise<TaskPlan>;
    },
    async writeState(state) {
      await fs.writeJson(path.join(dir, "state.json"), state, { spaces: 2 });
    },
    async readState() {
      const statePath = path.join(dir, "state.json");
      if (!(await fs.pathExists(statePath))) return undefined;
      return fs.readJson(statePath) as Promise<TaskState>;
    },
    async writeStepResult(stepIndex, result) {
      await fs.writeJson(path.join(dir, `step-${stepIndex}-result.json`), result, { spaces: 2 });
    }
  };
}

export async function listTasks(root: string): Promise<Array<{ taskId: string; goal: string; status: string; updatedAt: string }>> {
  await migrateProjectState(root);
  const dir = tasksDir(root);
  if (!(await fs.pathExists(dir))) return [];

  const entries = await fs.readdir(dir);
  const tasks: Array<{ taskId: string; goal: string; status: string; updatedAt: string }> = [];

  for (const entry of entries.sort().reverse()) {
    const statePath = path.join(dir, entry, "state.json");
    const planPath = path.join(dir, entry, "plan.json");
    if (!(await fs.pathExists(statePath))) continue;

    try {
      const state = await fs.readJson(statePath) as TaskState;
      let goal = "";
      if (await fs.pathExists(planPath)) {
        const plan = await fs.readJson(planPath) as TaskPlan;
        goal = plan.goal;
      }
      tasks.push({
        taskId: state.taskId,
        goal: goal || entry,
        status: state.status,
        updatedAt: state.updatedAt
      });
    } catch {
      // skip corrupted task dirs
    }
  }
  return tasks;
}

export async function loadTaskStore(root: string, taskId: string): Promise<TaskStore | undefined> {
  await migrateProjectState(root);
  const dir = path.join(tasksDir(root), taskId);
  if (!(await fs.pathExists(dir))) return undefined;

  return {
    dir,
    taskId,
    async writePlan(plan) {
      await fs.writeJson(path.join(dir, "plan.json"), plan, { spaces: 2 });
    },
    async readPlan() {
      return fs.readJson(path.join(dir, "plan.json")) as Promise<TaskPlan>;
    },
    async writeState(state) {
      await fs.writeJson(path.join(dir, "state.json"), state, { spaces: 2 });
    },
    async readState() {
      const statePath = path.join(dir, "state.json");
      if (!(await fs.pathExists(statePath))) return undefined;
      return fs.readJson(statePath) as Promise<TaskState>;
    },
    async writeStepResult(stepIndex, result) {
      await fs.writeJson(path.join(dir, `step-${stepIndex}-result.json`), result, { spaces: 2 });
    }
  };
}
