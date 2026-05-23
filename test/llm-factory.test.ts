import { describe, expect, it } from "vitest";
import { createLlmProvider } from "../src/llm/factory.js";
import { AnthropicCompatibleProvider } from "../src/llm/anthropic.js";
import { OpenAiProvider } from "../src/llm/openai.js";
import type { RuntimeConfig } from "../src/types.js";

const baseConfig: RuntimeConfig = {
  provider: "deepseek",
  apiKey: "test-key",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-pro",
  autoApply: false,
  maxRepairAttempts: 3,
  validationCommands: [],
  ignore: []
};

describe("createLlmProvider", () => {
  it("creates a deepseek provider", () => {
    expect(createLlmProvider(baseConfig)).toBeTruthy();
  });

  it("reports the correct missing env var for deepseek", () => {
    expect(() => createLlmProvider({ ...baseConfig, apiKey: undefined })).toThrow("codeshit config");
  });

  it("reports the correct missing env var for openai", () => {
    expect(() => createLlmProvider({ ...baseConfig, provider: "openai", apiKey: undefined })).toThrow("OPENAI_API_KEY");
  });

  it("uses Anthropic-compatible provider for /anthropic base URLs", () => {
    const provider = createLlmProvider({
      ...baseConfig,
      provider: "openai",
      baseUrl: "https://api.deepseek.com/anthropic"
    });

    expect(provider).toBeInstanceOf(AnthropicCompatibleProvider);
  });

  it("uses Anthropic-compatible provider for claude", () => {
    const provider = createLlmProvider({
      ...baseConfig,
      provider: "claude",
      baseUrl: "https://api.anthropic.com",
      model: "claude-sonnet-4-6"
    });

    expect(provider).toBeInstanceOf(AnthropicCompatibleProvider);
  });

  it("uses OpenAI provider for gemini's OpenAI-compatible endpoint", () => {
    const provider = createLlmProvider({
      ...baseConfig,
      provider: "gemini",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai/",
      model: "gemini-3.5-flash"
    });

    expect(provider).toBeInstanceOf(OpenAiProvider);
  });
});
