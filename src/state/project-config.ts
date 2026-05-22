import path from "node:path";
import fs from "fs-extra";
import { z } from "zod";
import type { ProjectConfig } from "../types.js";

export const defaultProjectConfig: ProjectConfig = {
  model: "deepseek-v4-pro",
  autoApply: false,
  maxRepairAttempts: 3,
  validationCommands: [],
  ignore: ["node_modules", "dist", "build", ".next", ".nuxt", "coverage", ".git"]
};

const projectConfigSchema = z.object({
  model: z.string().default(defaultProjectConfig.model),
  autoApply: z.boolean().default(defaultProjectConfig.autoApply),
  maxRepairAttempts: z.number().int().min(0).default(defaultProjectConfig.maxRepairAttempts),
  validationCommands: z.array(z.string()).default(defaultProjectConfig.validationCommands),
  ignore: z.array(z.string()).default(defaultProjectConfig.ignore)
});

export function projectConfigPath(root: string): string {
  return path.join(root, ".code-agent", "config.json");
}

export async function readProjectConfig(root: string): Promise<ProjectConfig> {
  const configPath = projectConfigPath(root);
  if (!(await fs.pathExists(configPath))) {
    return defaultProjectConfig;
  }
  const parsed = projectConfigSchema.safeParse(await fs.readJson(configPath));
  if (!parsed.success) {
    throw new Error(`Invalid project config: ${configPath}`);
  }
  return { ...defaultProjectConfig, ...parsed.data };
}

export async function writeProjectConfig(root: string, config: ProjectConfig): Promise<void> {
  const configPath = projectConfigPath(root);
  await fs.ensureDir(path.dirname(configPath));
  await fs.writeJson(configPath, config, { spaces: 2 });
}
