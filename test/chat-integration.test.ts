import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mathTs = [
  "export function add(a: number, b: number): number { return a + b; }",
  "export function subtract(a: number, b: number): number { return a - b; }",
  "export function multiply(a: number, b: number): number { return a * b; }",
  "export function divide(a: number, b: number): number {",
  "  if (b === 0) throw new Error('Division by zero');",
  "  return a / b;",
  "}"
].join("\n");

let testHome = "";

beforeEach(async () => {
  testHome = await fs.mkdtemp(path.join(os.tmpdir(), "codeshit-chat-home-"));
  vi.stubEnv("HOME", testHome);
});

afterEach(async () => {
  if (testHome) {
    await fs.rm(testHome, { recursive: true, force: true });
    testHome = "";
  }
});

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

const kotlinBuildGradle = [
  "plugins {",
  "    kotlin(\"jvm\") version \"1.9.25\"",
  "    kotlin(\"plugin.spring\") version \"1.9.25\"",
  "    id(\"org.springframework.boot\") version \"3.3.5\"",
  "    id(\"io.spring.dependency-management\") version \"1.1.6\"",
  "}",
  "",
  "repositories { mavenCentral() }"
].join("\n");

const kotlinManifestPlan = JSON.stringify({
  summary: "Scaffold Kotlin Spring Boot project with SQLite auth service",
  files: [{ path: "build.gradle.kts", purpose: "Gradle Kotlin build file" }],
  commands: []
});

const { mockState } = vi.hoisted(() => ({
  mockState: {
    inputIndex: 0,
    userMessages: [] as string[],
    promptMessages: [] as string[],
    inputs: [
      "帮我创建一个 TypeScript 数学工具库项目，要包含加减乘除四个函数，以及完整的单元测试",
      "/exit"
    ] as string[]
  }
}));

vi.mock("@inquirer/prompts", () => ({
  input: vi.fn().mockImplementation(async (config: { message?: string }) => {
    mockState.promptMessages.push(config.message ?? "");
    const inputs = mockState.inputs;
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
import { confirm } from "@inquirer/prompts";
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

function makePlanOnlyProvider() {
  const calls: string[] = [];
  const provider: LlmProvider = {
    async generateText(input) {
      calls.push(input.prompt);
      if (input.responseFormat === "json_object" && input.prompt.includes("User message:")) {
        return JSON.stringify({
          intent: "code_change",
          task: "should not be used",
          reason: "plan command should bypass intent classification"
        });
      }
      if (input.prompt.includes("Return JSON with this exact shape")) {
        return JSON.stringify({
          summary: "should not generate files",
          files: [{ path: "should-not-exist.txt", content: "nope" }],
          commands: [{ command: "npm test", reason: "should not run" }]
        });
      }
      return "Plan only:\n1. Inspect the current project.\n2. Decide the smallest implementation steps.\n3. Ask before making changes.";
    }
  };
  return { provider, calls };
}

function makePersistentPlanProvider() {
  const calls: string[] = [];
  const provider: LlmProvider = {
    async generateText(input) {
      calls.push(input.prompt);
      if (input.responseFormat === "json_object" && input.prompt.includes("Return JSON with this exact shape")) {
        return JSON.stringify({
          goal: "Add a reviewed login flow",
          steps: [{
            id: "1",
            title: "Implement login flow",
            description: "Add the agreed login flow from the plan-mode discussion.",
            expectedFiles: ["src/login.ts"],
            verification: "npm test",
            milestone: false,
            dependsOn: []
          }]
        });
      }
      return "Plan discussion reply";
    }
  };
  return { provider, calls };
}

function makeKotlinProviderThatMisclassifiesCreation(): LlmProvider {
  return {
    async generateText(input) {
      if (input.responseFormat === "json_object" && input.prompt.includes("User message:")) {
        return JSON.stringify({
          intent: "command",
          command: "./gradlew bootRun",
          reason: "Start app"
        });
      }
      if (input.responseFormat === "json_object" && input.prompt.includes("File to generate:")) {
        return JSON.stringify({ path: "build.gradle.kts", content: kotlinBuildGradle });
      }
      if (input.responseFormat === "json_object" && input.prompt.includes("Return JSON:")) {
        return kotlinManifestPlan;
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
  mockState.promptMessages = [];
  mockState.inputs = [
    "帮我创建一个 TypeScript 数学工具库项目，要包含加减乘除四个函数，以及完整的单元测试",
    "/exit"
  ];
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

describe("chat integration: Kotlin Spring Boot creation intent", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    resetMockState();
  });

  it("routes create-and-run requests to file generation even if the model would suggest bootRun", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-chat-kotlin-"));
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    mockState.inputs = [
      "我想创建一个基于Kotlin, springboo + sqllit的项目，先实现一个用email登录、注册的后端服务框架，运行服务并测试",
      "/exit"
    ];
    vi.mocked(createLlmProvider).mockReturnValue(makeKotlinProviderThatMisclassifiesCreation());

    await chatCommand(root, { autoApply: true, model: "deepseek-v4-pro" });

    await expect(fs.readFile(path.join(root, "build.gradle.kts"), "utf8")).resolves.toBe(kotlinBuildGradle);
  });
});

describe("chat integration: plan command", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    resetMockState();
  });

  it("runs /plan as a plan-only command without classifying, writing files, or running commands", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-chat-plan-"));
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    mockState.inputs = ["/plan add a login flow", "/exit"];
    const { provider, calls } = makePlanOnlyProvider();
    vi.mocked(createLlmProvider).mockReturnValue(provider);

    await chatCommand(root, { autoApply: true, model: "deepseek-v4-pro" });

    expect(calls.some((prompt) => prompt.includes("Return JSON matching one of:"))).toBe(false);
    expect(calls.some((prompt) => prompt.includes("Return JSON with this exact shape"))).toBe(false);
    await expect(fs.readFile(path.join(root, "should-not-exist.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the next user message as the plan goal after bare /plan", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-chat-plan-next-"));
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    mockState.inputs = ["/plan", "add a checkout flow", "/exit"];
    const { provider, calls } = makePlanOnlyProvider();
    vi.mocked(createLlmProvider).mockReturnValue(provider);

    await chatCommand(root, { autoApply: true, model: "deepseek-v4-pro" });

    expect(calls.some((prompt) => prompt.includes("add a checkout flow"))).toBe(true);
    expect(calls.some((prompt) => prompt.includes("Return JSON matching one of:"))).toBe(false);
    expect(mockState.promptMessages).toContain("you");
    expect(mockState.promptMessages).toContain("you [PLAN - Shift+Tab exits]");
  });

  it("exits bare plan mode with /plan exit without calling the model", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-chat-plan-exit-"));
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    mockState.inputs = ["/plan", "/plan exit", "/exit"];
    const { provider, calls } = makePlanOnlyProvider();
    vi.mocked(createLlmProvider).mockReturnValue(provider);

    await chatCommand(root, { autoApply: true, model: "deepseek-v4-pro" });

    expect(calls).toEqual([]);
  });

  it("ignores /apply-plan outside plan mode without calling the model", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-chat-apply-plan-inactive-"));
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    mockState.inputs = ["/apply-plan", "/exit"];
    const { provider, calls } = makePlanOnlyProvider();
    vi.mocked(createLlmProvider).mockReturnValue(provider);

    await chatCommand(root, { autoApply: true, model: "deepseek-v4-pro" });

    expect(calls).toEqual([]);
  });

  it("applies multi-turn plan mode by generating a task plan and saving it when execution is declined", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-chat-apply-plan-"));
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    mockState.inputs = ["/plan add login", "prefer session cookies", "/apply-plan", "/exit"];
    vi.mocked(confirm).mockResolvedValueOnce(false);
    const { provider, calls } = makePersistentPlanProvider();
    vi.mocked(createLlmProvider).mockReturnValue(provider);

    await chatCommand(root, { model: "deepseek-v4-pro" });

    expect(calls.some((prompt) => prompt.includes("prefer session cookies"))).toBe(true);
    expect(calls.some((prompt) => prompt.includes("Return JSON matching one of:"))).toBe(false);
    expect(calls.some((prompt) => prompt.includes("Return JSON with this exact shape"))).toBe(true);
    const taskRoot = path.join(root, ".codeshit", "tasks");
    const taskIds = await fs.readdir(taskRoot);
    expect(taskIds).toHaveLength(1);
    await expect(fs.readFile(path.join(taskRoot, taskIds[0]!, "plan.json"), "utf8")).resolves.toContain("Add a reviewed login flow");
    await expect(fs.readFile(path.join(root, "src/login.ts"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
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

type LanguageChatFixture = {
  name: string;
  prompt: string;
  task: string;
  files: Record<string, string>;
  expectedPath: string;
  expectedContent: string;
};

const languageChatFixtures: LanguageChatFixture[] = [
  {
    name: "JavaScript",
    prompt: "帮我创建一个 JavaScript 数学工具库项目，包含加减乘除函数",
    task: "创建 JavaScript 数学工具库",
    files: {
      "package.json": JSON.stringify({ name: "js-math-utils", type: "module", scripts: { test: "node --test" } }, null, 2),
      "src/math.js": [
        "export function add(a, b) { return a + b; }",
        "export function subtract(a, b) { return a - b; }",
        "export function multiply(a, b) { return a * b; }",
        "export function divide(a, b) { if (b === 0) throw new Error('division by zero'); return a / b; }"
      ].join("\n")
    },
    expectedPath: "src/math.js",
    expectedContent: "export function add(a, b) { return a + b; }"
  },
  {
    name: "Python",
    prompt: "帮我创建一个 Python 数学工具库项目，包含加减乘除函数",
    task: "创建 Python 数学工具库",
    files: {
      "pyproject.toml": "[project]\nname = \"py-math-utils\"\nversion = \"0.1.0\"\n",
      "src/math_utils.py": [
        "def add(a: int, b: int) -> int:",
        "    return a + b",
        "",
        "def divide(a: int, b: int) -> float:",
        "    if b == 0:",
        "        raise ValueError('division by zero')",
        "    return a / b"
      ].join("\n")
    },
    expectedPath: "src/math_utils.py",
    expectedContent: "def add(a: int, b: int) -> int:"
  },
  {
    name: "Rust",
    prompt: "帮我创建一个 Rust 数学工具库项目，包含加减乘除函数",
    task: "创建 Rust 数学工具库",
    files: {
      "Cargo.toml": "[package]\nname = \"rust-math-utils\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
      "src/lib.rs": [
        "pub fn add(a: i32, b: i32) -> i32 { a + b }",
        "pub fn subtract(a: i32, b: i32) -> i32 { a - b }",
        "pub fn multiply(a: i32, b: i32) -> i32 { a * b }",
        "pub fn divide(a: i32, b: i32) -> Option<i32> { if b == 0 { None } else { Some(a / b) } }"
      ].join("\n")
    },
    expectedPath: "src/lib.rs",
    expectedContent: "pub fn add(a: i32, b: i32) -> i32 { a + b }"
  },
  {
    name: "Java",
    prompt: "帮我创建一个 Java 数学工具库项目，包含加减乘除函数",
    task: "创建 Java 数学工具库",
    files: {
      "pom.xml": "<project><modelVersion>4.0.0</modelVersion><groupId>demo</groupId><artifactId>java-math-utils</artifactId><version>0.1.0</version></project>\n",
      "src/main/java/demo/MathUtils.java": [
        "package demo;",
        "",
        "public final class MathUtils {",
        "  public static int add(int a, int b) { return a + b; }",
        "}"
      ].join("\n")
    },
    expectedPath: "src/main/java/demo/MathUtils.java",
    expectedContent: "public static int add(int a, int b) { return a + b; }"
  },
  {
    name: "Swift",
    prompt: "帮我创建一个 Swift 数学工具库项目，包含加减乘除函数",
    task: "创建 Swift 数学工具库",
    files: {
      "Package.swift": "// swift-tools-version: 5.9\nimport PackageDescription\nlet package = Package(name: \"SwiftMathUtils\", products: [.library(name: \"SwiftMathUtils\", targets: [\"SwiftMathUtils\"])], targets: [.target(name: \"SwiftMathUtils\")])\n",
      "Sources/SwiftMathUtils/MathUtils.swift": [
        "public enum MathUtils {",
        "  public static func add(_ a: Int, _ b: Int) -> Int { a + b }",
        "}"
      ].join("\n")
    },
    expectedPath: "Sources/SwiftMathUtils/MathUtils.swift",
    expectedContent: "public static func add(_ a: Int, _ b: Int) -> Int { a + b }"
  },
  {
    name: "PHP",
    prompt: "帮我创建一个 PHP 数学工具库项目，包含加减乘除函数",
    task: "创建 PHP 数学工具库",
    files: {
      "composer.json": JSON.stringify({ name: "demo/php-math-utils", autoload: { "psr-4": { "Demo\\Math\\": "src/" } } }, null, 2),
      "src/MathUtils.php": [
        "<?php",
        "namespace Demo\\Math;",
        "",
        "final class MathUtils {",
        "    public static function add(int $a, int $b): int { return $a + $b; }",
        "}"
      ].join("\n")
    },
    expectedPath: "src/MathUtils.php",
    expectedContent: "public static function add(int $a, int $b): int { return $a + $b; }"
  },
  {
    name: "Ruby",
    prompt: "帮我创建一个 Ruby 数学工具库项目，包含加减乘除函数",
    task: "创建 Ruby 数学工具库",
    files: {
      "Gemfile": "source \"https://rubygems.org\"\n",
      "lib/math_utils.rb": [
        "module MathUtils",
        "  def self.add(a, b)",
        "    a + b",
        "  end",
        "end"
      ].join("\n")
    },
    expectedPath: "lib/math_utils.rb",
    expectedContent: "def self.add(a, b)"
  },
  {
    name: "C#",
    prompt: "帮我创建一个 C# 数学工具库项目，包含加减乘除函数",
    task: "创建 C# 数学工具库",
    files: {
      "MathUtils.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net8.0</TargetFramework></PropertyGroup></Project>\n",
      "MathUtils.cs": [
        "namespace Demo.Math;",
        "",
        "public static class MathUtils",
        "{",
        "    public static int Add(int a, int b) => a + b;",
        "}"
      ].join("\n")
    },
    expectedPath: "MathUtils.cs",
    expectedContent: "public static int Add(int a, int b) => a + b;"
  }
];

function makeLanguageProvider(fixture: LanguageChatFixture): LlmProvider {
  return {
    async generateText(input) {
      if (input.responseFormat === "json_object" && input.prompt.includes("User message:")) {
        return JSON.stringify({
          intent: "code_change",
          task: fixture.task,
          reason: `用户要求创建 ${fixture.name} 项目`
        });
      }
      if (input.responseFormat === "json_object" && input.prompt.includes("Files to generate")) {
        return JSON.stringify({
          files: Object.entries(fixture.files).map(([filePath, content]) => ({ path: filePath, content }))
        });
      }
      if (input.responseFormat === "json_object" && input.prompt.includes("File to generate:")) {
        const file = JSON.parse(input.prompt.slice(input.prompt.indexOf("File to generate:") + "File to generate:".length).trim()) as { path: string };
        return JSON.stringify({ path: file.path, content: fixture.files[file.path] ?? "" });
      }
      if (input.responseFormat === "json_object" && input.prompt.includes("Return JSON:")) {
        return JSON.stringify({
          summary: `Create ${fixture.name} math utility project`,
          files: Object.keys(fixture.files).map((filePath) => ({ path: filePath, purpose: `${fixture.name} project file` })),
          commands: []
        });
      }
      if (input.responseFormat === "json_object" && (input.prompt.includes("Return JSON with this exact shape") || input.prompt.includes("Command errors"))) {
        return JSON.stringify({
          summary: `Create ${fixture.name} math utility project`,
          files: Object.entries(fixture.files).map(([filePath, content]) => ({ path: filePath, content })),
          commands: []
        });
      }
      return JSON.stringify({ intent: "answer", answer: "done" });
    }
  };
}

describe("chat integration: additional language project generation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    resetMockState();
  });

  it.each(languageChatFixtures)("generates a $name project from chat", async (fixture) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `code-agent-chat-${fixture.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-`));
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");
    mockState.inputs = [fixture.prompt, "/exit"];
    vi.mocked(createLlmProvider).mockReturnValue(makeLanguageProvider(fixture));

    await chatCommand(root, { autoApply: true, model: "deepseek-v4-pro" });

    await expect(fs.readFile(path.join(root, fixture.expectedPath), "utf8")).resolves.toContain(fixture.expectedContent);
    for (const [filePath, content] of Object.entries(fixture.files)) {
      await expect(fs.readFile(path.join(root, filePath), "utf8")).resolves.toBe(content);
    }
  });
});

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
