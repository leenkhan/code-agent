import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it, vi, afterEach } from "vitest";

const mathTs = [
  "export function add(a: number, b: number): number { return a + b; }",
  "export function subtract(a: number, b: number): number { return a - b; }",
  "export function multiply(a: number, b: number): number { return a * b; }",
  "export function divide(a: number, b: number): number {",
  "  if (b === 0) throw new Error('Division by zero');",
  "  return a / b;",
  "}"
].join("\n");

const brokenMathTs = [
  "export function add(a: number, b: number): number { return a + b; }",
  "export function subtract(a: number, b: number): number { return a - b; }",
  "export function multiply(a: number, b: number): number { return a * b; }",
  "export function divide(a, b) { return a / b; }"
].join("\n");

const packageJson = JSON.stringify({
  name: "math-utils",
  version: "1.0.0",
  type: "module",
  scripts: { build: "tsc --noEmit" },
  devDependencies: { typescript: "^5.7.0", "@types/node": "^22.0.0" }
}, null, 2);

const tsconfigJson = JSON.stringify({
  compilerOptions: {
    target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext",
    strict: true, outDir: "dist", declaration: true, types: ["node"]
  },
  include: ["src", "test"]
}, null, 2);

const indexTs = "export { add, subtract, multiply, divide } from './math.js';\n";

function makeCodePlan(files: Record<string, string>, summary: string) {
  return JSON.stringify({
    summary,
    files: Object.entries(files).map(([p, content]) => ({ path: p, content })),
    commands: [
      { command: "npm install", reason: "Install dev dependencies" },
      { command: "npx tsc --noEmit", reason: "Type check the project" }
    ]
  });
}

const correctPlan = makeCodePlan({
  "package.json": packageJson,
  "tsconfig.json": tsconfigJson,
  "src/math.ts": mathTs,
  "src/index.ts": indexTs
}, "Create TypeScript math utility library");

const brokenPlan = makeCodePlan({
  "package.json": packageJson,
  "tsconfig.json": tsconfigJson,
  "src/math.ts": brokenMathTs,
  "src/index.ts": indexTs
}, "Create math utils (with a type error)");

const repairPlan = makeCodePlan({
  "src/math.ts": mathTs
}, "Fix type errors: add missing parameter types");

const { mockState } = vi.hoisted(() => ({
  mockState: { inputIndex: 0, userMessages: [] as string[] }
}));

vi.mock("@inquirer/prompts", () => ({
  input: vi.fn().mockImplementation(async () => {
    const inputs = [
      "帮我创建一个 TypeScript 数学工具库项目，要包含加减乘除四个函数，以及完整的单元测试",
      "/exit"
    ];
    const value = inputs[mockState.inputIndex] ?? "/exit";
    if (mockState.inputIndex < inputs.length) mockState.inputIndex += 1;
    mockState.userMessages.push(value);
    return value;
  }),
  confirm: vi.fn().mockResolvedValue(true),
  select: vi.fn(),
  password: vi.fn()
}));

import { chatCommand } from "../src/commands/chat.js";
import { createLlmProvider } from "../src/llm/factory.js";
import type { LlmProvider } from "../src/llm/provider.js";

vi.mock("../src/llm/factory.js", () => ({
  createLlmProvider: vi.fn()
}));

function makeSuccessProvider(): LlmProvider {
  let calls = 0;
  return {
    async generateText(input) {
      calls += 1;
      if (input.responseFormat === "json_object" && input.prompt.includes("User message:")) {
        return JSON.stringify({
          intent: "code_change",
          task: "创建一个 TypeScript 数学工具库，包含加减乘除函数和完整测试",
          reason: "用户要求创建一个完整的 TS 工具库项目"
        });
      }
      if (input.responseFormat === "json_object" && input.prompt.includes("Return JSON with this exact shape")) {
        return correctPlan;
      }
      if (input.responseFormat === "json_object" && input.prompt.includes("Command errors")) {
        return correctPlan;
      }
      return JSON.stringify({ intent: "answer", answer: "done" });
    }
  };
}

function makeRepairProvider(brokenResponse: string, fixedResponse: string, returnFixedAfterCalls: number): LlmProvider {
  let calls = 0;
  return {
    async generateText(input) {
      calls += 1;
      if (input.responseFormat === "json_object" && input.prompt.includes("User message:")) {
        return JSON.stringify({
          intent: "code_change",
          task: "创建 TypeScript 工具库",
          reason: "用户要求"
        });
      }
      // Repair calls include "Command errors" in the task → always return fixed
      if (input.responseFormat === "json_object" && input.prompt.includes("Command errors")) {
        return fixedResponse;
      }
      // Initial code generation → return broken for first N, then fixed
      if (input.responseFormat === "json_object" && input.prompt.includes("Return JSON with this exact shape")) {
        if (calls <= returnFixedAfterCalls) return brokenResponse;
        return fixedResponse;
      }
      return JSON.stringify({ intent: "answer", answer: "ok" });
    }
  };
}

function resetMockState() {
  mockState.inputIndex = 0;
  mockState.userMessages = [];
}

describe("chat integration: full code generation flow", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    resetMockState();
  });

  it("generates a complete TypeScript math library from natural language", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-chat-int-"));
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");

    vi.mocked(createLlmProvider).mockReturnValue(makeSuccessProvider());

    await chatCommand(root, { autoApply: true, model: "deepseek-v4-pro" });

    // Verify all files were created with correct content
    expect(await fs.readFile(path.join(root, "package.json"), "utf8")).toBe(packageJson);
    expect(await fs.readFile(path.join(root, "tsconfig.json"), "utf8")).toBe(tsconfigJson);
    expect(await fs.readFile(path.join(root, "src/math.ts"), "utf8")).toBe(mathTs);
    expect(await fs.readFile(path.join(root, "src/index.ts"), "utf8")).toBe(indexTs);

    // Verify directory structure
    const entries = await fs.readdir(root);
    expect(entries).toContain("src");
    expect(entries).toContain("package.json");
    expect(entries).toContain("tsconfig.json");
  });

  it("generated code passes TypeScript type checking", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-chat-tsc-"));
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");

    vi.mocked(createLlmProvider).mockReturnValue(makeSuccessProvider());

    await chatCommand(root, { autoApply: true, model: "deepseek-v4-pro" });

    // The chat already ran npm install + tsc --noEmit via autoApply
    // Verify tsc passes on the generated project
    const tscResult = await execa("npx", ["tsc", "--noEmit"], { cwd: root, reject: false });
    expect(tscResult.exitCode).toBe(0);
  }, 30000);
});

describe("chat integration: repair loop on broken code", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    resetMockState();
  });

  it("detects tsc failure, triggers repair, and writes fixed code", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-chat-repair-"));
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");

    // brokenPlan on calls 1-2 (intent→code_change), then repairPlan on call 3+ (repair)
    vi.mocked(createLlmProvider).mockReturnValue(
      makeRepairProvider(brokenPlan, repairPlan, 2)
    );

    await chatCommand(root, { autoApply: true, model: "deepseek-v4-pro" });

    // Verify the REPAIRED file was written (correct version with types)
    const mathContent = await fs.readFile(path.join(root, "src/math.ts"), "utf8");
    expect(mathContent).toContain("export function divide(a: number, b: number): number");
    expect(mathContent).not.toContain("export function divide(a, b)");

    // Verify it actually type checks
    const tscResult = await execa("npx", ["tsc", "--noEmit"], { cwd: root, reject: false });
    expect(tscResult.exitCode).toBe(0);
  }, 30000);

  it("exhausts max repair attempts when repair keeps failing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-chat-repair-exhaust-"));
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");

    // Provider that ALWAYS returns broken code (never fixes it)
    vi.mocked(createLlmProvider).mockReturnValue(
      makeRepairProvider(brokenPlan, brokenPlan, 999)
    );

    await chatCommand(root, { autoApply: true, model: "deepseek-v4-pro", maxRepairAttempts: "2" });

    // After 2 repair attempts with same broken code, the file should still be broken
    const mathContent = await fs.readFile(path.join(root, "src/math.ts"), "utf8");
    expect(mathContent).toContain("export function divide(a, b)");
    // tsc should still fail
    const tscResult = await execa("npx", ["tsc", "--noEmit"], { cwd: root, reject: false });
    expect(tscResult.exitCode).not.toBe(0);
  }, 30000);
});

// ── Go project fixtures ──────────────────────────────────────────────

const goMod = `module math-utils

go 1.21
`;

const goCalc = `package calc

import "errors"

func Add(a, b int) int { return a + b; }
func Subtract(a, b int) int { return a - b; }
func Multiply(a, b int) int { return a * b; }
func Divide(a, b int) (int, error) {
	if b == 0 { return 0, errors.New("division by zero") }
	return a / b, nil
}
`;

const goCalcBroken = `package calc

import "errors"

func Add(a, b int) int { return a - b; }
func Subtract(a, b int) int { return a - b; }
func Multiply(a, b int) int { return a * b; }
func Divide(a, b int) (int, error) {
	if b == 0 { return 0, errors.New("division by zero") }
	return a / b, nil
}
`;

const goCalcTest = `package calc

import "testing"

func TestAdd(t *testing.T) {
	if got := Add(2, 3); got != 5 { t.Errorf("Add(2,3)=%d, want 5", got) }
}
func TestSubtract(t *testing.T) {
	if got := Subtract(5, 3); got != 2 { t.Errorf("Subtract(5,3)=%d, want 2", got) }
}
func TestMultiply(t *testing.T) {
	if got := Multiply(4, 3); got != 12 { t.Errorf("Multiply(4,3)=%d, want 12", got) }
}
func TestDivide(t *testing.T) {
	got, err := Divide(10, 2)
	if err != nil { t.Fatalf("unexpected error: %v", err) }
	if got != 5 { t.Errorf("Divide(10,2)=%d, want 5", got) }
}
func TestDivideByZero(t *testing.T) {
	_, err := Divide(1, 0)
	if err == nil { t.Error("expected error for division by zero") }
}
`;

function makeGoPlan(calcContent: string, summary: string) {
  return JSON.stringify({
    summary,
    files: [
      { path: "go.mod", content: goMod },
      { path: "calc.go", content: calcContent },
      { path: "calc_test.go", content: goCalcTest }
    ],
    commands: [
      { command: "go test ./...", reason: "Run Go tests" }
    ]
  });
}

const correctGoPlan = makeGoPlan(goCalc, "Create Go math utility package");
const brokenGoPlan = makeGoPlan(goCalcBroken, "Create math utils (with a bug in Add)");
const repairGoPlan = JSON.stringify({
  summary: "Fix Add function: use + instead of -",
  files: [{ path: "calc.go", content: goCalc }],
  commands: [{ command: "go test ./...", reason: "Verify tests pass" }]
});

function makeGoProvider(): LlmProvider {
  let calls = 0;
  return {
    async generateText(input) {
      calls += 1;
      if (input.responseFormat === "json_object" && input.prompt.includes("User message:")) {
        return JSON.stringify({
          intent: "code_change",
          task: "创建一个 Go 语言数学工具包，包含加减乘除函数和完整测试",
          reason: "用户要求创建 Go 工具包"
        });
      }
      if (input.responseFormat === "json_object" && input.prompt.includes("Command errors")) {
        return repairGoPlan;
      }
      if (input.responseFormat === "json_object" && input.prompt.includes("Return JSON with this exact shape")) {
        if (calls <= 2) return brokenGoPlan;
        return correctGoPlan;
      }
      return JSON.stringify({ intent: "answer", answer: "done" });
    }
  };
}

function makeGoSuccessProvider(): LlmProvider {
  return {
    async generateText(input) {
      if (input.responseFormat === "json_object" && input.prompt.includes("User message:")) {
        return JSON.stringify({
          intent: "code_change",
          task: "创建一个 Go 语言数学工具包，包含加减乘除函数和完整测试",
          reason: "用户要求创建 Go 工具包"
        });
      }
      if (input.responseFormat === "json_object" && (input.prompt.includes("Return JSON with this exact shape") || input.prompt.includes("Command errors"))) {
        return correctGoPlan;
      }
      return JSON.stringify({ intent: "answer", answer: "done" });
    }
  };
}

describe("chat integration: Go project generation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    resetMockState();
  });

  it("generates a complete Go math package from natural language", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-chat-go-"));
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    vi.mocked(createLlmProvider).mockReturnValue(makeGoSuccessProvider());

    await chatCommand(root, { autoApply: true, model: "deepseek-v4-pro" });

    expect(await fs.readFile(path.join(root, "go.mod"), "utf8")).toBe(goMod);
    expect(await fs.readFile(path.join(root, "calc.go"), "utf8")).toBe(goCalc);
    expect(await fs.readFile(path.join(root, "calc_test.go"), "utf8")).toBe(goCalcTest);
  });

  it("generated Go code passes tests", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-chat-go-test-"));
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    vi.mocked(createLlmProvider).mockReturnValue(makeGoSuccessProvider());

    await chatCommand(root, { autoApply: true, model: "deepseek-v4-pro" });

    // go test should pass
    const testResult = await execa("go", ["test", "./..."], { cwd: root, reject: false });
    expect(testResult.exitCode).toBe(0);
    expect(testResult.stdout).toContain("ok");
  }, 30000);
});

describe("chat integration: Go repair loop on broken code", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    resetMockState();
  });

  it("detects go test failure, triggers repair, and writes fixed code", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-chat-go-repair-"));
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    vi.mocked(createLlmProvider).mockReturnValue(makeGoProvider());

    await chatCommand(root, { autoApply: true, model: "deepseek-v4-pro" });

    // After repair, the file should have the correct Add function
    const calcContent = await fs.readFile(path.join(root, "calc.go"), "utf8");
    expect(calcContent).toContain("return a + b");
    expect(calcContent).not.toContain("Add(a, b int) int { return a - b");

    // go test should pass after repair
    const testResult = await execa("go", ["test", "./..."], { cwd: root, reject: false });
    expect(testResult.exitCode).toBe(0);
  }, 30000);

  it("exhausts max repair attempts when Go repair keeps failing", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-chat-go-repair-exhaust-"));
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");

    // Provider that always returns broken code (never fixes Add)
    vi.mocked(createLlmProvider).mockReturnValue(
      makeRepairProvider(brokenGoPlan, brokenGoPlan, 999)
    );

    await chatCommand(root, { autoApply: true, model: "deepseek-v4-pro", maxRepairAttempts: "2" });

    // After 2 failed repair attempts, the file should still be broken
    const calcContent = await fs.readFile(path.join(root, "calc.go"), "utf8");
    expect(calcContent).toContain("return a - b");

    // go test should still fail
    const testResult = await execa("go", ["test", "./..."], { cwd: root, reject: false });
    expect(testResult.exitCode).not.toBe(0);
  }, 30000);
});

