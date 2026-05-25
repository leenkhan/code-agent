import { confirm, input, password, select } from "@inquirer/prompts";
import { providerCatalog, getProviderDefinition } from "../llm/catalog.js";
import { getDefaultGlobalProviderConfig, globalConfigPath, readGlobalConfig, writeGlobalConfig } from "../state/global-config.js";
import { logger } from "../ui/logger.js";
import type { GlobalProviderConfig, ProviderName } from "../types.js";

export async function configCommand(): Promise<void> {
  const globalPath = globalConfigPath();
  const globalConfig = await readGlobalConfig();
  const defaultProviderConfig = getDefaultGlobalProviderConfig(globalConfig);
  const provider = await select<ProviderName>({
    message: "LLM provider:",
    default: defaultProviderConfig.provider,
    choices: providerCatalog.map((entry) => ({ name: entry.displayName, value: entry.id }))
  });
  const providerDefinition = getProviderDefinition(provider);
  const existingProviderConfig = globalConfig.providers.find((entry) => entry.provider === provider);
  const enteredApiKey = await password({
    message: `${providerDefinition.displayName} API key (leave blank to ${existingProviderConfig?.apiKey ? "keep existing key or use" : "use"} ${providerDefinition.envKey}):`,
    mask: "*"
  });
  const apiKey = enteredApiKey || existingProviderConfig?.apiKey;
  const model = await select<string>({
    message: "Default model:",
    default: existingProviderConfig && providerDefinition.models.includes(existingProviderConfig.model)
      ? existingProviderConfig.model
      : providerDefinition.defaultModel,
    choices: providerDefinition.models.map((modelName) => ({ name: modelName, value: modelName }))
  });
  const baseUrl = await input({
    message: "API base URL:",
    default: existingProviderConfig?.baseUrl ?? providerDefinition.defaultBaseUrl
  });
  const shouldSetDefault = await confirm({
    message: "Set this provider and model as the default?",
    default: existingProviderConfig?.isDefault ?? (globalConfig.providers.length === 0)
  });
  const nextProviderConfig: GlobalProviderConfig = {
    provider,
    apiKey: apiKey || undefined,
    model,
    baseUrl: baseUrl || undefined,
    isDefault: shouldSetDefault
  };
  const providersWithoutCurrent = globalConfig.providers.filter((entry) => entry.provider !== provider);
  const providers = [
    ...providersWithoutCurrent.map((entry) => ({
      ...entry,
      isDefault: shouldSetDefault ? false : entry.isDefault
    })),
    nextProviderConfig
  ];

  if (!providers.some((entry) => entry.isDefault)) {
    nextProviderConfig.isDefault = true;
  }

  await writeGlobalConfig({
    providers
  });
  logger.success(`Global config saved: ${globalPath}`);
}
