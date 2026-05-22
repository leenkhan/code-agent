import path from "node:path";
import fs from "fs-extra";
import type { ProjectContext, RunResult } from "../types.js";

export type RunStore = {
  dir: string;
  writeText(name: string, content: string): Promise<void>;
  writeJson(name: string, content: unknown): Promise<void>;
};

function slugify(task: string): string {
  return task
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 36) || "task";
}

function timestamp(): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

export function runsDir(root: string): string {
  return path.join(root, ".code-agent", "runs");
}

export async function createRunStore(root: string, task: string): Promise<RunStore> {
  const dir = path.join(runsDir(root), `${timestamp()}-${slugify(task)}`);
  await fs.ensureDir(dir);
  return {
    dir,
    async writeText(name, content) {
      await fs.writeFile(path.join(dir, name), content, "utf8");
    },
    async writeJson(name, content) {
      await fs.writeJson(path.join(dir, name), content, { spaces: 2 });
    }
  };
}

export async function latestRun(root: string): Promise<string | undefined> {
  const dir = runsDir(root);
  if (!(await fs.pathExists(dir))) {
    return undefined;
  }
  const entries = (await fs.readdir(dir)).sort();
  const latest = entries.at(-1);
  return latest ? path.join(dir, latest) : undefined;
}

export async function saveInitialArtifacts(store: RunStore, task: string, context: ProjectContext): Promise<void> {
  await store.writeText("task.txt", task);
  await store.writeJson("context.json", context);
}

export async function saveResult(store: RunStore, result: RunResult): Promise<void> {
  await store.writeJson("result.json", result);
}
