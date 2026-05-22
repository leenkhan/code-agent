import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectProjectContext } from "../src/project/context.js";
import { renderContext } from "../src/utils/llm.js";
import type { ProjectConfig } from "../src/types.js";

const config: ProjectConfig = {
  model: "test-model",
  autoApply: false,
  maxRepairAttempts: 1,
  validationCommands: [],
  ignore: []
};

async function makeRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "code-agent-context-"));
}

describe("collectProjectContext", () => {
  it("collects TypeScript symbols and parse diagnostics", async () => {
    const root = await makeRoot();
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(
      path.join(root, "src", "index.ts"),
      [
        "export interface User { id: string }",
        "export class UserService {",
        "  getUser(id: string) { return id; }",
        "}",
        "export const createUser = () => ({ id: '1' });",
        "export function broken("
      ].join("\n")
    );

    const context = await collectProjectContext(root, config, "inspect symbols");

    expect(context.importantFiles.map((file) => file.path)).toContain("src/index.ts");
    expect(context.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/index.ts", name: "User", kind: "interface", exported: true }),
        expect.objectContaining({ path: "src/index.ts", name: "UserService", kind: "class", exported: true }),
        expect.objectContaining({ path: "src/index.ts", name: "createUser", kind: "variable", exported: true })
      ])
    );
    expect(context.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src/index.ts", severity: "error" })
      ])
    );
  });

  it("collects simple symbols for non-TypeScript source files", async () => {
    const root = await makeRoot();
    await fs.writeFile(path.join(root, "main.py"), "class Runner:\n    pass\n\ndef run():\n    return Runner()\n");

    const context = await collectProjectContext(root, config);

    expect(context.symbols).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "main.py", name: "Runner", kind: "python-class" }),
        expect.objectContaining({ path: "main.py", name: "run", kind: "python-function" })
      ])
    );
  });

  it("keeps sensitive files out of text and structured context", async () => {
    const root = await makeRoot();
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src", "safe.ts"), "export function safe() { return true; }\n");
    await fs.writeFile(path.join(root, ".env"), "SECRET_TOKEN=hidden\nexport function leaked() {}\n");

    const context = await collectProjectContext(root, config);

    expect(context.fileTree).toContain("src/safe.ts");
    expect(context.fileTree).not.toContain(".env");
    expect(context.importantFiles.map((file) => file.path)).not.toContain(".env");
    expect(context.symbols).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "src/safe.ts", name: "safe" })])
    );
    expect(context.symbols).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ".env", name: "leaked" })])
    );
  });

  it("renders structured context without changing callers", async () => {
    const root = await makeRoot();
    await fs.writeFile(path.join(root, "index.ts"), "export function entry() { return 1; }\n");

    const context = await collectProjectContext(root, config);
    const rendered = JSON.parse(renderContext(context)) as { symbols?: unknown[]; diagnostics?: unknown[] };

    expect(rendered.symbols).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "index.ts", name: "entry", kind: "function" })])
    );
    expect(rendered).toHaveProperty("diagnostics");
  });
});
