import path from "node:path";
import fs from "fs-extra";
import { logger } from "../ui/logger.js";
import { globalConfigPath, readGlobalConfig } from "../state/global-config.js";
import { projectConfigPath, readProjectConfig } from "../state/project-config.js";
import { resolveRuntimeConfig, supportedDeepSeekModels } from "../state/config.js";
import { detectImportantFiles } from "../project/detect.js";
import { isGitAvailable, isGitRepo } from "../tools/git.js";
import { formatList } from "../ui/format.js";

export async function doctorCommand(root: string): Promise<void> {
  const globalPath = globalConfigPath();
  const projectPath = projectConfigPath(root);
  const globalExists = await fs.pathExists(globalPath);
  const projectExists = await fs.pathExists(projectPath);
  const globalConfig = await readGlobalConfig();
  const projectConfig = await readProjectConfig(root);
  const runtimeConfig = await resolveRuntimeConfig(root);
  const gitDirExists = await fs.pathExists(path.join(root, ".git"));
  const gitAvailable = await isGitAvailable();
  const gitRepo = await isGitRepo(root);
  const importantFiles = await detectImportantFiles(root);
  const envName = globalConfig.provider === "deepseek" ? "DEEPSEEK_API_KEY" : "OPENAI_API_KEY";
  const envKey = globalConfig.provider === "deepseek" ? process.env.DEEPSEEK_API_KEY : process.env.OPENAI_API_KEY;

  logger.heading("Code Agent Doctor");
  logger.info(`Current working directory: ${process.cwd()}`);
  logger.info(`Detected project root: ${root}`);
  logger.info(`Git available: ${gitAvailable ? "yes" : "no"}`);
  logger.info(`Current folder is git repo: ${gitRepo ? "yes" : "no"}`);
  logger.info(`.git directory present: ${gitDirExists ? "yes" : "no"}`);
  logger.info(`Node.js version: ${process.version}`);
  logger.info(`Global config exists: ${globalExists ? "yes" : "no"} (${globalPath})`);
  logger.info(`Project config exists: ${projectExists ? "yes" : "no"} (${projectPath})`);
  logger.info(`LLM provider: ${runtimeConfig.provider}`);
  logger.info(`Model: ${runtimeConfig.model}`);
  logger.info(`API base URL: ${runtimeConfig.baseUrl ?? "(provider default)"}`);
  logger.info(`${envName} configured: ${envKey || globalConfig.apiKey ? "yes" : "no"}`);
  if (runtimeConfig.provider === "deepseek" && projectConfig.model && !supportedDeepSeekModels.includes(projectConfig.model)) {
    logger.warn(`Project config model "${projectConfig.model}" is not supported by DeepSeek. Using ${runtimeConfig.model}.`);
  }
  logger.heading("Detected important files");
  logger.info(formatList(importantFiles));
  logger.heading("Configured validation commands");
  logger.info(formatList(projectConfig.validationCommands));
  if (!gitRepo) {
    logger.warn("Safety warning: this project is not a git repository. Patch apply/revert requires git.");
  }
}
