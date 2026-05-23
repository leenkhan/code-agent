import { input, password, select } from "@inquirer/prompts";
import { providerCatalog, getProviderDefinition } from "../llm/catalog.js";
import { globalConfigPath, readGlobalConfig, writeGlobalConfig } from "../state/global-config.js";
import { logger } from "../ui/logger.js";
import type { ProviderName } from "../types.js";

export async function configCommand(): Promise<void> {
  const globalPath = globalConfigPath();
  const globalConfig = await readGlobalConfig();
  const provider = await select<ProviderName>({
    message: "LLM provider:",
    default: globalConfig.provider,
    choices: providerCatalog.map((entry) => ({ name: entry.displayName, value: entry.id }))
  });
  const providerDefinition = getProviderDefinition(provider);
  const enteredApiKey = await password({
    message: `${providerDefinition.displayName} API key (leave blank to ${globalConfig.provider === provider && globalConfig.apiKey ? "keep existing key or use" : "use"} ${providerDefinition.envKey}):`,
    mask: "*"
  });
  const apiKey = enteredApiKey || (globalConfig.provider === provider ? globalConfig.apiKey : undefined);
  const model = await select<string>({
    message: "Default model:",
    default: globalConfig.provider === provider && providerDefinition.models.includes(globalConfig.model)
      ? globalConfig.model
      : providerDefinition.defaultModel,
    choices: providerDefinition.models.map((modelName) => ({ name: modelName, value: modelName }))
  });
  const baseUrl = await input({
    message: "API base URL:",
    default: globalConfig.provider === provider ? globalConfig.baseUrl ?? providerDefinition.defaultBaseUrl : providerDefinition.defaultBaseUrl
  });

  await writeGlobalConfig({
    provider,
    apiKey: apiKey || undefined,
    model,
    baseUrl: baseUrl || undefined
  });
  logger.success(`Global config saved: ${globalPath}`);
}
