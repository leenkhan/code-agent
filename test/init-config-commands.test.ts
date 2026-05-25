import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { confirm, input, password, select } from "@inquirer/prompts";
import { configCommand } from "../src/commands/config.js";
import { initCommand } from "../src/commands/init.js";

vi.mock("@inquirer/prompts", () => ({
  confirm: vi.fn(),
  input: vi.fn(),
  password: vi.fn(),
  select: vi.fn()
}));

describe("config and init commands", () => {
  let home: string;
  let root: string;

  beforeEach(async () => {
    home = await fs.mkdtemp(path.join(os.tmpdir(), "codeshit-home-"));
    root = await fs.mkdtemp(path.join(os.tmpdir(), "codeshit-root-"));
    vi.stubEnv("HOME", home);
    vi.mocked(confirm).mockReset();
    vi.mocked(input).mockReset();
    vi.mocked(password).mockReset();
    vi.mocked(select).mockReset();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  });

  it("config writes only global LLM config", async () => {
    vi.mocked(select)
      .mockResolvedValueOnce("qwen-cn")
      .mockResolvedValueOnce("qwen3.6-flash");
    vi.mocked(confirm).mockResolvedValueOnce(true);
    vi.mocked(password).mockResolvedValueOnce("dashscope-key");
    vi.mocked(input).mockResolvedValueOnce("https://dashscope.aliyuncs.com/compatible-mode/v1");

    await configCommand();

    const globalConfig = JSON.parse(await fs.readFile(path.join(home, ".codeshit", "config.json"), "utf8")) as Record<string, unknown>;
    expect(globalConfig).toEqual({
      providers: [
        {
          provider: "deepseek",
          model: "deepseek-v4-pro",
          baseUrl: "https://api.deepseek.com/anthropic",
          isDefault: false
        },
        {
          provider: "qwen-cn",
          apiKey: "dashscope-key",
          model: "qwen3.6-flash",
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          isDefault: true
        }
      ]
    });
    await expect(fs.stat(path.join(root, ".codeshit", "config.json"))).rejects.toThrow();
  });

  it("config updates an existing provider without removing other providers", async () => {
    await fs.mkdir(path.join(home, ".codeshit"), { recursive: true });
    await fs.writeFile(
      path.join(home, ".codeshit", "config.json"),
      JSON.stringify({
        providers: [
          {
            provider: "deepseek",
            apiKey: "deepseek-key",
            model: "deepseek-v4-pro",
            baseUrl: "https://api.deepseek.com/anthropic",
            isDefault: true
          },
          {
            provider: "qwen-cn",
            apiKey: "old-qwen-key",
            model: "qwen3.6-plus",
            baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
            isDefault: false
          }
        ]
      }),
      "utf8"
    );
    vi.mocked(select)
      .mockResolvedValueOnce("qwen-cn")
      .mockResolvedValueOnce("qwen3.6-flash");
    vi.mocked(confirm).mockResolvedValueOnce(false);
    vi.mocked(password).mockResolvedValueOnce("");
    vi.mocked(input).mockResolvedValueOnce("https://dashscope.aliyuncs.com/compatible-mode/v1");

    await configCommand();

    const globalConfig = JSON.parse(await fs.readFile(path.join(home, ".codeshit", "config.json"), "utf8")) as Record<string, unknown>;
    expect(globalConfig).toEqual({
      providers: [
        {
          provider: "deepseek",
          apiKey: "deepseek-key",
          model: "deepseek-v4-pro",
          baseUrl: "https://api.deepseek.com/anthropic",
          isDefault: true
        },
        {
          provider: "qwen-cn",
          apiKey: "old-qwen-key",
          model: "qwen3.6-flash",
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          isDefault: false
        }
      ]
    });
  });

  it("init writes only project config and runs directory", async () => {
    vi.mocked(input)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("pnpm test, pnpm lint");
    vi.mocked(confirm).mockResolvedValueOnce(true);

    await initCommand(root);

    const projectConfig = JSON.parse(await fs.readFile(path.join(root, ".codeshit", "config.json"), "utf8")) as Record<string, unknown>;
    expect(projectConfig).toEqual({
      autoApply: true,
      maxRepairAttempts: 3,
      validationCommands: ["pnpm test", "pnpm lint"],
      ignore: ["node_modules", "dist", "build", ".next", ".nuxt", "coverage", ".git"]
    });
    expect(projectConfig.provider).toBeUndefined();
    expect(projectConfig.apiKey).toBeUndefined();
    expect(projectConfig.baseUrl).toBeUndefined();
    await expect(fs.stat(path.join(root, ".codeshit", "runs"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(home, ".codeshit", "config.json"))).rejects.toThrow();
  });
});
