import { describe, expect, it, vi } from "vitest";
import { parseChatIntent, classifyChatIntent } from "../src/agent/intent.js";
import type { LlmProvider } from "../src/llm/provider.js";

describe("parseChatIntent", () => {
  it("parses answer intent", () => {
    expect(parseChatIntent('{"intent":"answer","answer":"你好"}')).toEqual({
      intent: "answer",
      answer: "你好"
    });
  });

  it("parses code change intent", () => {
    expect(parseChatIntent('{"intent":"code_change","task":"更新 README","reason":"用户要求修改文档"}')).toEqual({
      intent: "code_change",
      task: "更新 README",
      reason: "用户要求修改文档"
    });
  });

  it("parses fenced json", () => {
    expect(parseChatIntent('```json\n{"intent":"command","command":"pnpm test","reason":"用户要求测试"}\n```')).toEqual({
      intent: "command",
      command: "pnpm test",
      reason: "用户要求测试"
    });
  });

  it("parses json without fence when surrounded by text", () => {
    expect(parseChatIntent('some text {"intent":"answer","answer":"ok"} more text')).toEqual({
      intent: "answer",
      answer: "ok"
    });
  });

  it("throws on malformed json", () => {
    expect(() => parseChatIntent("not json at all")).toThrow();
  });

  it("throws on missing intent field", () => {
    expect(() => parseChatIntent('{"foo":"bar"}')).toThrow();
  });

  it("throws on unknown intent value", () => {
    expect(() => parseChatIntent('{"intent":"unknown"}')).toThrow();
  });
});

describe("classifyChatIntent", () => {
  it("forces project creation requests to code_change before asking the provider", async () => {
    const provider: LlmProvider = {
      generateText: vi.fn(async () => JSON.stringify({
        intent: "command",
        command: "./gradlew bootRun",
        reason: "wrong"
      }))
    };

    const message = "我想创建一个基于Kotlin, springboo + sqllit的项目，先实现一个用email登录、注册的后端服务框架，运行服务并测试";
    const result = await classifyChatIntent({
      provider,
      model: "test",
      message,
      history: [],
      context: { root: "/tmp", fileTree: [], importantFiles: [] }
    });

    expect(result).toEqual({
      intent: "code_change",
      task: message,
      reason: "The user asked to create or implement project code; any requested run/test steps should happen after file generation."
    });
    expect(provider.generateText).not.toHaveBeenCalled();
  });

  it("returns answer intent on parse failure with fallback", async () => {
    const provider: LlmProvider = {
      async generateText() {
        return "not valid json";
      }
    };

    const result = await classifyChatIntent({
      provider,
      model: "test",
      message: "hello",
      history: [],
      context: { root: "/tmp", fileTree: [], importantFiles: [] }
    });

    expect(result.intent).toBe("answer");
    expect((result as { intent: "answer"; answer: string }).answer).toBeTruthy();
  });

  it("classifies answer intent from provider response", async () => {
    const provider: LlmProvider = {
      async generateText() {
        return JSON.stringify({ intent: "answer", answer: "这是一个好问题" });
      }
    };

    const result = await classifyChatIntent({
      provider,
      model: "test",
      message: "what is this?",
      history: [],
      context: { root: "/tmp", fileTree: [], importantFiles: [] }
    });

    expect(result).toEqual({ intent: "answer", answer: "这是一个好问题" });
  });

  it("classifies code_change intent from provider response", async () => {
    const provider: LlmProvider = {
      async generateText() {
        return JSON.stringify({ intent: "code_change", task: "修 bug", reason: "用户要求" });
      }
    };

    const result = await classifyChatIntent({
      provider,
      model: "test",
      message: "fix the bug",
      history: [],
      context: { root: "/tmp", fileTree: [], importantFiles: [] }
    });

    expect(result).toEqual({ intent: "code_change", task: "修 bug", reason: "用户要求" });
  });

  it("classifies command intent from provider response", async () => {
    const provider: LlmProvider = {
      async generateText() {
        return JSON.stringify({ intent: "command", command: "pnpm test", reason: "run tests" });
      }
    };

    const result = await classifyChatIntent({
      provider,
      model: "test",
      message: "run tests",
      history: [],
      context: { root: "/tmp", fileTree: [], importantFiles: [] }
    });

    expect(result).toEqual({ intent: "command", command: "pnpm test", reason: "run tests" });
  });

  it("includes runtime context in the prompt", async () => {
    let capturedPrompt = "";
    const provider: LlmProvider = {
      async generateText(input) {
        capturedPrompt = input.prompt;
        return JSON.stringify({ intent: "answer", answer: "ok" });
      }
    };

    await classifyChatIntent({
      provider,
      model: "test",
      message: "stop server",
      history: [],
      context: { root: "/tmp", fileTree: [], importantFiles: [] },
      runtimeContext: "id=1, command=pnpm dev"
    });

    expect(capturedPrompt).toContain("id=1, command=pnpm dev");
  });
});
