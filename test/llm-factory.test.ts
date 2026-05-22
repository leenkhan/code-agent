import { describe, expect, it } from "vitest";
import { createLlmProvider } from "../src/llm/factory.js";
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
    expect(() => createLlmProvider({ ...baseConfig, apiKey: undefined })).toThrow("DEEPSEEK_API_KEY");
  });

  it("reports the correct missing env var for openai", () => {
    expect(() => createLlmProvider({ ...baseConfig, provider: "openai", apiKey: undefined })).toThrow("OPENAI_API_KEY");
  });
});
