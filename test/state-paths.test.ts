import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  globalStateDir,
  migrateGlobalState,
  migrateProjectState,
  projectStateDir
} from "../src/state/paths.js";
import { projectConfigPath, readProjectConfig } from "../src/state/project-config.js";
import { tasksDir } from "../src/state/task-store.js";
import { runsDir } from "../src/state/run-store.js";

describe("state paths and migration", () => {
  let cleanup: string[] = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    for (const dir of cleanup) {
      await fs.remove(dir);
    }
    cleanup = [];
  });

  it("uses .codeshit for project state helpers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeshit-paths-"));
    cleanup.push(root);

    expect(projectStateDir(root)).toBe(path.join(root, ".codeshit"));
    expect(projectConfigPath(root)).toBe(path.join(root, ".codeshit", "config.json"));
    expect(runsDir(root)).toBe(path.join(root, ".codeshit", "runs"));
    expect(tasksDir(root)).toBe(path.join(root, ".codeshit", "tasks"));
  });

  it("keeps project config separate when the project root is the home directory", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codeshit-home-root-"));
    cleanup.push(home);
    vi.stubEnv("HOME", home);

    expect(projectStateDir(home)).toBe(path.join(home, ".codeshit"));
    expect(projectConfigPath(home)).toBe(path.join(home, ".codeshit", "project-config.json"));
  });

  it("migrates old project state when new state is absent", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeshit-migrate-project-"));
    cleanup.push(root);
    await fs.outputJson(path.join(root, ".code-agent", "config.json"), {
      model: "deepseek-v4-flash",
      autoApply: false,
      maxRepairAttempts: 1,
      validationCommands: [],
      ignore: []
    });

    const config = await readProjectConfig(root);

    expect(config.model).toBe("deepseek-v4-flash");
    expect(await fs.pathExists(path.join(root, ".code-agent"))).toBe(false);
    expect(await fs.pathExists(path.join(root, ".codeshit", "config.json"))).toBe(true);
  });

  it("preserves old project state when new state already exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "codeshit-migrate-conflict-"));
    cleanup.push(root);
    await fs.outputFile(path.join(root, ".code-agent", "tasks", "old.txt"), "old");
    await fs.outputFile(path.join(root, ".codeshit", "tasks", "new.txt"), "new");

    await migrateProjectState(root);

    expect(await fs.pathExists(path.join(root, ".code-agent", "tasks", "old.txt"))).toBe(true);
    expect(await fs.pathExists(path.join(root, ".codeshit", "tasks", "new.txt"))).toBe(true);
  });

  it("uses and migrates ~/.codeshit for global state", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "codeshit-home-"));
    cleanup.push(home);
    vi.stubEnv("HOME", home);
    await fs.outputJson(path.join(home, ".code-agent", "config.json"), {
      provider: "deepseek",
      model: "deepseek-v4-pro"
    });

    expect(globalStateDir()).toBe(path.join(home, ".codeshit"));
    await migrateGlobalState();

    expect(await fs.pathExists(path.join(home, ".code-agent"))).toBe(false);
    expect(await fs.pathExists(path.join(home, ".codeshit", "config.json"))).toBe(true);
  });
});
