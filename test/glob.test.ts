import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { defaultSafeGlobIgnorePatterns, safeProjectGlob } from "../src/project/glob.js";
import type { ProjectConfig } from "../src/types.js";

const config: ProjectConfig = {
  model: "test-model",
  autoApply: false,
  maxRepairAttempts: 1,
  validationCommands: [],
  ignore: [".cache", "tmp"]
};

async function makeRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "code-agent-glob-"));
}

describe("safe project globbing", () => {
  it("includes built-in protected-directory ignore patterns", () => {
    expect(defaultSafeGlobIgnorePatterns).toEqual(
      expect.arrayContaining([
        ".Trash",
        ".Trash/**",
        ".ssh",
        ".ssh/**",
        ".codeshit",
        ".codeshit/**",
        ".code-agent",
        ".code-agent/**"
      ])
    );
  });

  it("merges project ignore and gitignore before traversal", async () => {
    const root = await makeRoot();
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, ".gitignore"), "ignored-dir\n!ignored-dir/keep.ts\n");
    await fs.mkdir(path.join(root, "ignored-dir"), { recursive: true });
    await fs.mkdir(path.join(root, "tmp"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "keep.ts"), "export const keep = 1;\n");
    await fs.writeFile(path.join(root, "ignored-dir", "drop.ts"), "export const drop = 1;\n");
    await fs.writeFile(path.join(root, "ignored-dir", "keep.ts"), "export const keep = 2;\n");
    await fs.writeFile(path.join(root, "tmp", "config.ts"), "export const temp = 1;\n");

    const files = await safeProjectGlob(["**/*"], root, { config });

    expect(files).toContain("src/keep.ts");
    expect(files).not.toContain("ignored-dir/drop.ts");
    expect(files).not.toContain("ignored-dir/keep.ts");
    expect(files).not.toContain("tmp/config.ts");
  });
});
