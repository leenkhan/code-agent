import { describe, expect, it } from "vitest";
import { defaultGlobalConfig } from "../src/state/global-config.js";
import { defaultProjectConfig } from "../src/state/project-config.js";

describe("project config defaults", () => {
  it("uses safe defaults", () => {
    expect(defaultProjectConfig.autoApply).toBe(false);
    expect(defaultProjectConfig.maxRepairAttempts).toBe(3);
    expect(defaultProjectConfig.ignore).toContain(".git");
    expect(defaultProjectConfig.model).toBeUndefined();
  });
});

describe("global config defaults", () => {
  it("uses DeepSeek's Anthropic-compatible endpoint by default", () => {
    expect(defaultGlobalConfig.providers).toEqual([
      {
        provider: "deepseek",
        model: "deepseek-v4-pro",
        baseUrl: "https://api.deepseek.com/anthropic",
        isDefault: true
      }
    ]);
  });
});
