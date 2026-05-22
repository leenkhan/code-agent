import type { ProjectConfig, RuntimeConfig } from "../types.js";
import { readGlobalConfig } from "./global-config.js";
import { readProjectConfig } from "./project-config.js";
import { defaultProjectConfig } from "./project-config.js";

export type RuntimeOverrides = {
  model?: string;
  autoApply?: boolean;
  maxRepairAttempts?: number;
  validationCommands?: string[];
};

const deepSeekModels = new Set(["deepseek-v4-pro", "deepseek-v4-flash"]);

function resolveModel(input: {
  provider: RuntimeConfig["provider"];
  overrideModel?: string;
  projectModel?: string;
  globalModel?: string;
}): string {
  if (input.provider !== "deepseek") {
    return input.overrideModel ?? input.projectModel ?? input.globalModel ?? defaultProjectConfig.model;
  }
  if (input.overrideModel) {
    if (!deepSeekModels.has(input.overrideModel)) {
      throw new Error("Unsupported DeepSeek model. Use deepseek-v4-pro or deepseek-v4-flash.");
    }
    return input.overrideModel;
  }
  if (input.projectModel && deepSeekModels.has(input.projectModel)) {
    return input.projectModel;
  }
  if (input.globalModel && deepSeekModels.has(input.globalModel)) {
    return input.globalModel;
  }
  return "deepseek-v4-pro";
}

export async function resolveRuntimeConfig(root: string, overrides: RuntimeOverrides = {}): Promise<RuntimeConfig> {
  const globalConfig = await readGlobalConfig();
  const projectConfig = await readProjectConfig(root);
  const envApiKey = globalConfig.provider === "deepseek" ? process.env.DEEPSEEK_API_KEY : process.env.OPENAI_API_KEY;
  const model = resolveModel({
    provider: globalConfig.provider,
    overrideModel: overrides.model,
    projectModel: projectConfig.model,
    globalModel: globalConfig.model
  });
  const mergedProject: ProjectConfig = {
    ...projectConfig,
    model,
    autoApply: overrides.autoApply ?? projectConfig.autoApply,
    maxRepairAttempts: overrides.maxRepairAttempts ?? projectConfig.maxRepairAttempts,
    validationCommands: overrides.validationCommands?.length ? overrides.validationCommands : projectConfig.validationCommands
  };
  return {
    ...mergedProject,
    provider: globalConfig.provider,
    apiKey: envApiKey ?? globalConfig.apiKey,
    baseUrl: globalConfig.baseUrl,
    model
  };
}

export const supportedDeepSeekModels = [...deepSeekModels];
