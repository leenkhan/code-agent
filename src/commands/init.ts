import { confirm, input } from "@inquirer/prompts";
import fs from "fs-extra";
import { logger } from "../ui/logger.js";
import { defaultProjectConfig, projectConfigPath, readProjectConfig, writeProjectConfig } from "../state/project-config.js";
import { runsDir } from "../state/run-store.js";

export async function initCommand(root: string): Promise<void> {
  const projectPath = projectConfigPath(root);
  const projectExists = await fs.pathExists(projectPath);
  const projectConfig = projectExists ? await readProjectConfig(root) : defaultProjectConfig;
  if (!projectExists || await confirm({ message: "Update project config?", default: false })) {
    const model = await input({ message: "Project model override (blank to use global default):", default: projectConfig.model ?? "" });
    const autoApply = await confirm({ message: "Auto-apply patches by default?", default: projectConfig.autoApply });
    const validation = await input({
      message: "Validation commands, comma-separated (blank for none):",
      default: projectConfig.validationCommands.join(", ")
    });
    await writeProjectConfig(root, {
      ...projectConfig,
      model: model.trim() || undefined,
      autoApply,
      validationCommands: validation.split(",").map((cmd) => cmd.trim()).filter(Boolean)
    });
    logger.success(`Project config saved: ${projectPath}`);
  }
  await fs.ensureDir(runsDir(root));
  logger.success(`Runs directory ready: ${runsDir(root)}`);
  logger.info("Next steps: run `codeshit config`, `codeshit doctor`, then `codeshit plan \"your task\"`.");
}
