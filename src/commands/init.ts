import { confirm, input, password, select } from "@inquirer/prompts";
import fs from "fs-extra";
import { logger } from "../ui/logger.js";
import { globalConfigPath, readGlobalConfig, writeGlobalConfig } from "../state/global-config.js";
import { defaultProjectConfig, projectConfigPath, readProjectConfig, writeProjectConfig } from "../state/project-config.js";
import { runsDir } from "../state/run-store.js";
import type { ProviderName } from "../types.js";

export async function initCommand(root: string): Promise<void> {
  const globalPath = globalConfigPath();
  const globalExists = await fs.pathExists(globalPath);
  const globalConfig = await readGlobalConfig();
  if (!globalExists || await confirm({ message: "Update global config?", default: false })) {
    const provider = await select<ProviderName>({
      message: "LLM provider:",
      default: globalConfig.provider,
      choices: [
        { name: "DeepSeek V4", value: "deepseek" },
        { name: "OpenAI", value: "openai" }
      ]
    });
    const envName = provider === "deepseek" ? "DEEPSEEK_API_KEY" : "OPENAI_API_KEY";
    const defaultModel = provider === "deepseek" ? "deepseek-v4-pro" : "gpt-4.1";
    const defaultBaseUrl = provider === "deepseek" ? "https://api.deepseek.com" : undefined;
    const apiKey = globalConfig.apiKey ?? await password({ message: `${provider} API key (leave blank to use ${envName}):`, mask: "*" });
    const model = await input({ message: "Default model:", default: globalConfig.provider === provider ? globalConfig.model : defaultModel });
    const baseUrl = await input({
      message: "API base URL:",
      default: globalConfig.provider === provider ? globalConfig.baseUrl ?? defaultBaseUrl : defaultBaseUrl
    });
    await writeGlobalConfig({ provider, apiKey: apiKey || undefined, model, baseUrl: baseUrl || undefined });
    logger.success(`Global config saved: ${globalPath}`);
  }

  const projectPath = projectConfigPath(root);
  const projectExists = await fs.pathExists(projectPath);
  const projectConfig = projectExists ? await readProjectConfig(root) : defaultProjectConfig;
  if (!projectExists || await confirm({ message: "Update project config?", default: false })) {
    const model = await input({ message: "Project model:", default: projectConfig.model });
    const autoApply = await confirm({ message: "Auto-apply patches by default?", default: projectConfig.autoApply });
    const validation = await input({
      message: "Validation commands, comma-separated (blank for none):",
      default: projectConfig.validationCommands.join(", ")
    });
    await writeProjectConfig(root, {
      ...projectConfig,
      model,
      autoApply,
      validationCommands: validation.split(",").map((cmd) => cmd.trim()).filter(Boolean)
    });
    logger.success(`Project config saved: ${projectPath}`);
  }
  await fs.ensureDir(runsDir(root));
  logger.success(`Runs directory ready: ${runsDir(root)}`);
  logger.info("Next steps: run `code-agent doctor`, then `code-agent plan \"your task\"`.");
}
