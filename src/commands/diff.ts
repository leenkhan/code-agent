import path from "node:path";
import fs from "fs-extra";
import { gitDiff } from "../tools/git.js";
import { latestRun } from "../state/run-store.js";
import { logger } from "../ui/logger.js";

export async function diffCommand(root: string): Promise<void> {
  logger.heading("Current git diff");
  logger.info(await gitDiff(root) || "(empty)");
  const latest = await latestRun(root);
  if (latest) {
    const patchPath = path.join(latest, "patch.diff");
    logger.info(`Latest run: ${latest}`);
    logger.info(`Latest patch: ${await fs.pathExists(patchPath) ? patchPath : "(none)"}`);
  }
}
