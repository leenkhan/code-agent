import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimeConfig } from "../src/state/config.js";

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

  it("uses raw project model overrides without provider-specific validation", async () => {
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
    expect(config.model).toBe("help");
  });

  it("accepts explicit model overrides as advanced raw values", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-config-"));
    vi.stubEnv("DEEPSEEK_API_KEY", "test-key");

    await expect(resolveRuntimeConfig(root, { model: "help" })).resolves.toMatchObject({ model: "help" });
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

  it("reads provider-specific env keys for new providers", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-root-"));
    await fs.mkdir(path.join(home, ".codeshit"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".codeshit", "config.json"),
      JSON.stringify({
        provider: "qwen-cn",
        model: "qwen3.6-plus",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1"
      }),
      "utf8"
    );
    vi.stubEnv("DASHSCOPE_API_KEY", "dashscope-key");

    const config = await resolveRuntimeConfig(root);

    expect(config.provider).toBe("qwen-cn");
    expect(config.apiKey).toBe("dashscope-key");
  });

  it("uses global provider model when project config has no model override", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-root-"));
    await fs.mkdir(path.join(home, ".codeshit"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".codeshit", "config.json"),
      JSON.stringify({
        provider: "claude",
        apiKey: "claude-key",
        model: "claude-sonnet-4-6",
        baseUrl: "https://api.anthropic.com"
      }),
      "utf8"
    );

    const config = await resolveRuntimeConfig(root);

    expect(config.provider).toBe("claude");
    expect(config.model).toBe("claude-sonnet-4-6");
  });

  it("keeps global credentials when the project root is the home directory", async () => {
    await fs.mkdir(path.join(home, ".codeshit"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".codeshit", "config.json"),
      JSON.stringify({
        provider: "deepseek",
        apiKey: "saved-key",
        model: "deepseek-v4-pro",
        baseUrl: "https://api.deepseek.com/anthropic"
      }),
      "utf8"
    );
    await fs.writeFile(
      path.join(home, ".codeshit", "project-config.json"),
      JSON.stringify({
        model: "deepseek-v4-pro",
        autoApply: true,
        maxRepairAttempts: 2,
        validationCommands: ["pnpm test"],
        ignore: []
      }),
      "utf8"
    );

    const config = await resolveRuntimeConfig(home);

    expect(config.apiKey).toBe("saved-key");
    expect(config.baseUrl).toBe("https://api.deepseek.com/anthropic");
    expect(config.autoApply).toBe(true);
    expect(config.validationCommands).toEqual(["pnpm test"]);
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
