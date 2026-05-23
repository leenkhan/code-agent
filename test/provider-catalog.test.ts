import { describe, expect, it } from "vitest";
import { providerCatalog, providerIds } from "../src/llm/catalog.js";

describe("provider catalog", () => {
  it("contains all supported providers", () => {
    expect(providerIds).toEqual([
      "openai",
      "deepseek",
      "zhipu-cn",
      "zhipu-global",
      "kimi-cn",
      "kimi-global",
      "minimax-cn",
      "minimax-global",
      "qwen-cn",
      "qwen-global",
      "claude",
      "gemini"
    ]);
  });

  it("has complete provider metadata", () => {
    for (const provider of providerCatalog) {
      expect(provider.displayName).toBeTruthy();
      expect(provider.envKey).toMatch(/_API_KEY$/);
      expect(provider.defaultModel).toBeTruthy();
      expect(provider.models).toContain(provider.defaultModel);
      expect(provider.models.length).toBeGreaterThan(0);
      expect(["openai", "anthropic"]).toContain(provider.wireProtocol);
      if (provider.id !== "openai") {
        expect(provider.defaultBaseUrl).toMatch(/^https:\/\//);
      }
    }
  });
});
