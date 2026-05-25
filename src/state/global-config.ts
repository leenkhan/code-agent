import path from "node:path";
import fs from "fs-extra";
import { z } from "zod";
import type { GlobalConfig, GlobalProviderConfig } from "../types.js";
import { getProviderDefinition, providerIds } from "../llm/catalog.js";
import { globalStateDir, migrateGlobalState } from "./paths.js";

const defaultProvider = getProviderDefinition("deepseek");

export const defaultGlobalConfig: GlobalConfig = {
  providers: [
    {
      provider: defaultProvider.id,
      model: defaultProvider.defaultModel,
      baseUrl: defaultProvider.defaultBaseUrl,
      isDefault: true
    }
  ]
};

const globalProviderConfigSchema = z.object({
  provider: z.enum(providerIds),
  apiKey: z.string().optional(),
  model: z.string(),
  baseUrl: z.string().url().optional(),
  isDefault: z.boolean().default(false)
});

const globalConfigSchema = z.object({
  providers: z.array(globalProviderConfigSchema)
});

const legacyGlobalConfigSchema = z.object({
  provider: z.enum(providerIds).default(defaultProvider.id),
  apiKey: z.string().optional(),
  model: z.string().default(defaultProvider.defaultModel),
  baseUrl: z.string().url().optional()
});

export function globalConfigPath(): string {
  return path.join(globalStateDir(), "config.json");
}

export function getDefaultGlobalProviderConfig(config: GlobalConfig): GlobalProviderConfig {
  return normalizeGlobalConfig(config).providers.find((provider) => provider.isDefault)
    ?? defaultGlobalConfig.providers[0]!;
}

export function normalizeGlobalConfig(config: GlobalConfig): GlobalConfig {
  const providersById = new Map<GlobalProviderConfig["provider"], GlobalProviderConfig>();
  for (const providerConfig of config.providers) {
    const definition = getProviderDefinition(providerConfig.provider);
    providersById.set(providerConfig.provider, {
      provider: providerConfig.provider,
      apiKey: providerConfig.apiKey || undefined,
      model: providerConfig.model || definition.defaultModel,
      baseUrl: providerConfig.baseUrl || definition.defaultBaseUrl,
      isDefault: providerConfig.isDefault
    });
  }

  const providers = [...providersById.values()];
  if (providers.length === 0) {
    providers.push(defaultGlobalConfig.providers[0]!);
  }

  const defaultIndex = providers.findIndex((provider) => provider.isDefault);
  return {
    providers: providers.map((provider, index) => ({
      ...provider,
      isDefault: defaultIndex === -1 ? index === 0 : index === defaultIndex
    }))
  };
}

function parseGlobalConfig(raw: unknown, configPath: string): GlobalConfig {
  const parsed = globalConfigSchema.safeParse(raw);
  if (parsed.success) {
    return normalizeGlobalConfig(parsed.data);
  }

  const legacyParsed = legacyGlobalConfigSchema.safeParse(raw);
  if (legacyParsed.success) {
    const provider = getProviderDefinition(legacyParsed.data.provider);
    return normalizeGlobalConfig({
      providers: [
        {
          provider: legacyParsed.data.provider,
          apiKey: legacyParsed.data.apiKey,
          model: legacyParsed.data.model,
          baseUrl: legacyParsed.data.baseUrl ?? provider.defaultBaseUrl,
          isDefault: true
        }
      ]
    });
  }

  throw new Error(`Invalid global config: ${configPath}`);
}

export async function readGlobalConfig(): Promise<GlobalConfig> {
  await migrateGlobalState();
  const configPath = globalConfigPath();
  if (!(await fs.pathExists(configPath))) {
    return defaultGlobalConfig;
  }
  return parseGlobalConfig(await fs.readJson(configPath), configPath);
}

export async function writeGlobalConfig(config: GlobalConfig): Promise<void> {
  await migrateGlobalState();
  const configPath = globalConfigPath();
  await fs.ensureDir(path.dirname(configPath));
  await fs.writeJson(configPath, normalizeGlobalConfig(config), { spaces: 2 });
}
