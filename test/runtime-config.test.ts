import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimeConfig, supportedDeepSeekModels } from "../src/state/config.js";

describe("resolveRuntimeConfig", () => {
  let home: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "codeshit-home-"));
    vi.stubEnv("HOME", home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
  });

  it("falls back from invalid project deepseek model to global deepseek model", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-config-"));
    await fs.mkdir(path.join(root, ".code-agent"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".code-agent", "config.json"),
      JSON.stringify({ model: "help", autoApply: false, maxRepairAttempts: 3, validationCommands: [], ignore: [] }),
      "utf8"
    );
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");

    const config = await resolveRuntimeConfig(root);

    expect(config.provider).toBe("deepseek");
    expect(config.model).toBe("deepseek-v4-pro");
  });

  it("rejects invalid explicit deepseek model overrides", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-config-"));
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");

    await expect(resolveRuntimeConfig(root, { model: "help" })).rejects.toThrow("Unsupported DeepSeek model");
  });

  it("accepts valid deepseek model from project config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-config-"));
    await fs.mkdir(path.join(root, ".code-agent"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".code-agent", "config.json"),
      JSON.stringify({ model: "deepseek-v4-flash", autoApply: false, maxRepairAttempts: 1, validationCommands: [], ignore: [] }),
      "utf8"
    );
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");

    const config = await resolveRuntimeConfig(root);

    expect(config.model).toBe("deepseek-v4-flash");
  });

  it("uses explicit model override over project config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-config-"));
    await fs.mkdir(path.join(root, ".code-agent"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".code-agent", "config.json"),
      JSON.stringify({ model: "deepseek-v4-flash", autoApply: false, maxRepairAttempts: 1, validationCommands: [], ignore: [] }),
      "utf8"
    );
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");

    const config = await resolveRuntimeConfig(root, { model: "deepseek-v4-pro" });

    expect(config.model).toBe("deepseek-v4-pro");
  });

  it("env API key overrides config file apiKey", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-root-"));
    vi.stubEnv("DEEPSEEK_API_KEY", "env-key");

    const config = await resolveRuntimeConfig(root);

    expect(config.apiKey).toBe("env-key");
  });

  it("reads DEEPSEEK_API_KEY from env when provider is deepseek", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-root-"));
    vi.stubEnv("DEEPSEEK_API_KEY", "env-test-key");

    const config = await resolveRuntimeConfig(root);

    expect(config.apiKey).toBe("env-test-key");
  });

  it("overrides autoApply from CLI options", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-config-"));
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");

    const config = await resolveRuntimeConfig(root, { autoApply: true });

    expect(config.autoApply).toBe(true);
  });

  it("overrides maxRepairAttempts from CLI options", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-config-"));
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");

    const config = await resolveRuntimeConfig(root, { maxRepairAttempts: 5 });

    expect(config.maxRepairAttempts).toBe(5);
  });

  it("uses CLI validation commands over project config", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-config-"));
    await fs.mkdir(path.join(root, ".code-agent"), { recursive: true });
    await fs.writeFile(
      path.join(root, ".code-agent", "config.json"),
      JSON.stringify({ model: "deepseek-v4-pro", autoApply: false, maxRepairAttempts: 3, validationCommands: ["pnpm build"], ignore: [] }),
      "utf8"
    );
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");

    const config = await resolveRuntimeConfig(root, { validationCommands: ["pnpm lint"] });

    expect(config.validationCommands).toEqual(["pnpm lint"]);
  });

  it("defaults autoApply to false and maxRepairAttempts to 3", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-config-"));
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");

    const config = await resolveRuntimeConfig(root);

    expect(config.autoApply).toBe(false);
    expect(config.maxRepairAttempts).toBe(3);
    expect(config.validationCommands).toEqual([]);
  });
});

describe("supportedDeepSeekModels", () => {
  it("lists deepseek-v4-pro and deepseek-v4-flash", () => {
    expect(supportedDeepSeekModels).toContain("deepseek-v4-pro");
    expect(supportedDeepSeekModels).toContain("deepseek-v4-flash");
    expect(supportedDeepSeekModels.length).toBe(2);
  });
});
