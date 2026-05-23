import path from "node:path";
import fs from "fs-extra";
import { z } from "zod";
import type { GlobalConfig } from "../types.js";
import { getProviderDefinition, providerIds } from "../llm/catalog.js";
import { globalStateDir, migrateGlobalState } from "./paths.js";

const defaultProvider = getProviderDefinition("deepseek");

export const defaultGlobalConfig: GlobalConfig = {
  provider: defaultProvider.id,
  model: defaultProvider.defaultModel,
  baseUrl: defaultProvider.defaultBaseUrl
};

const globalConfigSchema = z.object({
  provider: z.enum(providerIds).default(defaultGlobalConfig.provider),
  apiKey: z.string().optional(),
  model: z.string().default(defaultGlobalConfig.model),
  baseUrl: z.string().url().optional()
});

export function globalConfigPath(): string {
  return path.join(globalStateDir(), "config.json");
}

export async function readGlobalConfig(): Promise<GlobalConfig> {
  await migrateGlobalState();
  const configPath = globalConfigPath();
  if (!(await fs.pathExists(configPath))) {
    return defaultGlobalConfig;
  }
  const parsed = globalConfigSchema.safeParse(await fs.readJson(configPath));
  if (!parsed.success) {
    throw new Error(`Invalid global config: ${configPath}`);
  }
  return { ...defaultGlobalConfig, ...parsed.data };
}

export async function writeGlobalConfig(config: GlobalConfig): Promise<void> {
  await migrateGlobalState();
  const configPath = globalConfigPath();
  await fs.ensureDir(path.dirname(configPath));
  await fs.writeJson(configPath, config, { spaces: 2 });
}
