import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { execa } from "execa";
import { applyFileActions, generateCodeActionPlan, generateEnvironmentFix, parseCodeActionPlan, validateCodeActionPlan } from "../src/agent/actions.js";
import type { LlmProvider } from "../src/llm/provider.js";

describe("code actions", () => {
  it("parses structured file and command actions", () => {
    const plan = parseCodeActionPlan(JSON.stringify({
      summary: "Create app",
      files: [{ path: "app/main.py", content: "print('ok')\n" }],
      commands: [{ command: "python app/main.py", reason: "smoke test" }]
    }));

    expect(plan.files[0]?.path).toBe("app/main.py");
    expect(plan.commands[0]?.command).toBe("python app/main.py");
  });

  it("throws a clear error for non-json action output", () => {
    expect(() => parseCodeActionPlan("bash\npip install fastapi")).toThrow("not valid JSON");
  });

  it("blocks unsafe file paths", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-actions-"));
    const errors = validateCodeActionPlan(root, {
      summary: "bad",
      files: [{ path: "../outside.txt", content: "bad" }],
      commands: []
    });

    expect(errors.join("\n")).toContain("Path traversal blocked");
  });

  it("blocks writes into virtual environment directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-actions-"));
    const errors = validateCodeActionPlan(root, {
      summary: "bad",
      files: [{ path: "backserve/venv/bin/python", content: "#!/bin/sh\n" }],
      commands: []
    });

    expect(errors.join("\n")).toContain("Forbidden write path blocked");
  });

  it("drops unsafe generated environment fix files", async () => {
    const provider: LlmProvider = {
      async generateText() {
        return JSON.stringify({
          files: [{ path: "backserve/venv/bin/python", content: "#!/bin/sh\n" }],
          commands: []
        });
      }
    };

    const fix = await generateEnvironmentFix({
      provider,
      model: "test-model",
      issue: {
        summary: "Validation stopped because the local development environment is missing required tools or services.",
        details: ["Missing command while running \"python -c pass\": python"],
        suggestions: ["Install or add \"python\" to PATH, then rerun the command."]
      },
      context: {
        root: "/tmp/project",
        fileTree: [],
        importantFiles: []
      },
      failedCommand: "python -c pass"
    });

    expect(fix).toBeNull();
  });

  it("can require file actions for code change tasks", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-actions-"));
    const errors = validateCodeActionPlan(root, {
      summary: "Only explain how to open a file",
      files: [],
      commands: [{ command: "echo open index.html", reason: "manual instruction" }]
    }, { requireFiles: true });

    expect(errors).toContain("No file actions were returned for a code change task.");
  });

  it("writes confirmed file actions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-actions-"));
    await applyFileActions(root, [{ path: "app/main.py", content: "print('ok')\n" }]);

    await expect(fs.readFile(path.join(root, "app/main.py"), "utf8")).resolves.toBe("print('ok')\n");
  });

  it("stores and applies file actions as a patch in git projects", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-actions-"));
    await execa("git", ["init"], { cwd: root });
    await fs.writeFile(path.join(root, "README.md"), "old\n", "utf8");

    const result = await applyFileActions(root, [
      { path: "README.md", content: "new\n" },
      { path: "src/main.ts", content: "export const ok = true;\n" }
    ], {
      artifactDir: path.join(root, ".codeshit", "runs", "test-run"),
      patchName: "patch.diff"
    });

    const patch = await fs.readFile(path.join(root, ".codeshit", "runs", "test-run", "patch.diff"), "utf8");
    expect(result.appliedWithPatch).toBe(true);
    expect(result.filesChanged).toEqual(["README.md", "src/main.ts"]);
    expect(patch).toContain("--- a/README.md");
    expect(patch).toContain("+++ b/README.md");
    expect(patch).toContain("-old");
    expect(patch).toContain("+new");
    expect(patch).toContain("--- /dev/null");
    expect(patch).toContain("+++ b/src/main.ts");
    await expect(fs.readFile(path.join(root, "README.md"), "utf8")).resolves.toBe("new\n");
    await expect(fs.readFile(path.join(root, "src/main.ts"), "utf8")).resolves.toBe("export const ok = true;\n");
  });

  it("falls back to manifest and per-file generation when full action generation fails", async () => {
    const calls: string[] = [];
    const progress: string[] = [];
    const provider: LlmProvider = {
      async generateText(input) {
        calls.push(input.system);
        if (calls.length === 1) {
          throw new Error("timeout");
        }
        if (calls.length === 2) {
          return JSON.stringify({
            summary: "Create compact app",
            files: [{ path: "main.py", purpose: "FastAPI app" }],
            commands: [{ command: "python -m py_compile main.py", reason: "syntax check" }]
          });
        }
        return JSON.stringify({ path: "main.py", content: "print('ok')\n" });
      }
    };

    const plan = await generateCodeActionPlan({
      provider,
      model: "test",
      task: "add one utility file",
      context: { root: "/tmp/test", fileTree: [], importantFiles: [] },
      onProgress(message) {
        progress.push(message);
      }
    });

    expect(plan.files).toEqual([{ path: "main.py", content: "print('ok')\n" }]);
    expect(plan.commands[0]?.command).toBe("python -m py_compile main.py");
    expect(progress).toEqual([
      "Generating file actions: drafting complete plan",
      "Generating file actions: planning file list",
      "Generating file actions: parsing file list",
      "Generating file actions: files 1-1/1",
      "Generating file actions: assembling plan"
    ]);
  });

  it("uses manifest-first generation for larger project scaffolds", async () => {
    const calls: string[] = [];
    const progress: string[] = [];
    const provider: LlmProvider = {
      async generateText(input) {
        calls.push(input.system);
        if (calls.length === 1) {
          return JSON.stringify({
            summary: "Create Kotlin backend",
            files: [{ path: "build.gradle.kts", purpose: "Gradle build" }],
            commands: [{ command: "gradle test", reason: "run tests" }]
          });
        }
        return JSON.stringify({ path: "build.gradle.kts", content: "plugins {}\n" });
      }
    };

    const plan = await generateCodeActionPlan({
      provider,
      model: "test",
      task: "Create a Kotlin Spring Boot project with SQLite",
      context: { root: "/tmp/test", fileTree: [], importantFiles: [] },
      onProgress(message) {
        progress.push(message);
      }
    });

    expect(calls[0]).toContain("compact file manifest");
    expect(plan.files).toEqual([{ path: "build.gradle.kts", content: "plugins {}\n" }]);
    expect(progress[0]).toBe("Generating file actions: planning file list");
    expect(progress).toContain("Generating file actions: files 1-1/1");
  });

  it("fails chunked generation when manifest files do not produce content", async () => {
    const provider: LlmProvider = {
      async generateText(input) {
        if (input.system.includes("compact file manifest")) {
          return JSON.stringify({
            summary: "Create HTML game",
            files: [{ path: "index.html", purpose: "single-file game" }],
            commands: []
          });
        }
        throw new Error("Anthropic-compatible API response did not include text content.");
      }
    };

    await expect(generateCodeActionPlan({
      provider,
      model: "test",
      task: "创建一个项目，实现俄罗斯方块小游戏",
      context: { root: "/tmp/test", fileTree: [], importantFiles: [] }
    })).rejects.toThrow("Failed to generate file contents");
  });
});
