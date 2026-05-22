import { describe, expect, it } from "vitest";
import { defaultProjectConfig } from "../src/state/project-config.js";

describe("project config defaults", () => {
  it("uses safe defaults", () => {
    expect(defaultProjectConfig.autoApply).toBe(false);
    expect(defaultProjectConfig.maxRepairAttempts).toBe(3);
    expect(defaultProjectConfig.ignore).toContain(".git");
    expect(defaultProjectConfig.model).toBe("deepseek-v4-pro");
  });
});
