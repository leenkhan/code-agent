import type { ProjectConfig, RuntimeConfig } from "../types.js";
import { getEnvApiKey, getProviderDefinition } from "../llm/catalog.js";
import { getDefaultGlobalProviderConfig, readGlobalConfig } from "./global-config.js";
import { readProjectConfig } from "./project-config.js";
import { defaultProjectConfig } from "./project-config.js";

export type RuntimeOverrides = {
  model?: string;
  autoApply?: boolean;
  maxRepairAttempts?: number;
  validationCommands?: string[];
};

function resolveModel(input: {
  provider: RuntimeConfig["provider"];
  overrideModel?: string;
  projectModel?: string;
  globalModel?: string;
}): string {
  return input.overrideModel ?? input.projectModel ?? input.globalModel ?? getProviderDefinition(input.provider).defaultModel;
}

export async function resolveRuntimeConfig(root: string, overrides: RuntimeOverrides = {}): Promise<RuntimeConfig> {
  const globalConfig = await readGlobalConfig();
  const defaultProviderConfig = getDefaultGlobalProviderConfig(globalConfig);
  const projectConfig = await readProjectConfig(root);
  const provider = getProviderDefinition(defaultProviderConfig.provider);
  const envApiKey = getEnvApiKey(defaultProviderConfig.provider);
  const model = resolveModel({
    provider: defaultProviderConfig.provider,
    overrideModel: overrides.model,
    projectModel: projectConfig.model,
    globalModel: defaultProviderConfig.model
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
    provider: defaultProviderConfig.provider,
    apiKey: envApiKey ?? defaultProviderConfig.apiKey,
    baseUrl: defaultProviderConfig.baseUrl ?? provider.defaultBaseUrl,
    model
  };
}
