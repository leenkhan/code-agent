import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { applyFileActions, generateCodeActionPlan, parseCodeActionPlan, validateCodeActionPlan } from "../src/agent/actions.js";
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

  it("writes confirmed file actions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-actions-"));
    await applyFileActions(root, [{ path: "app/main.py", content: "print('ok')\n" }]);

    await expect(fs.readFile(path.join(root, "app/main.py"), "utf8")).resolves.toBe("print('ok')\n");
  });

  it("falls back to manifest and per-file generation when full action generation fails", async () => {
    const calls: string[] = [];
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
      task: "create app",
      context: { root: "/tmp/test", fileTree: [], importantFiles: [] }
    });

    expect(plan.files).toEqual([{ path: "main.py", content: "print('ok')\n" }]);
    expect(plan.commands[0]?.command).toBe("python -m py_compile main.py");
  });
});
