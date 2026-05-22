import path from "node:path";
import fs from "fs-extra";
import { askConfirm } from "../ui/confirm.js";
import { logger } from "../ui/logger.js";
import { latestRun } from "../state/run-store.js";
import { revertPatch } from "../patch/revert.js";

export async function revertCommand(root: string): Promise<void> {
  const latest = await latestRun(root);
  if (!latest) {
    throw new Error("No previous run found.");
  }
  const patchPath = path.join(latest, "patch.diff");
  if (!(await fs.pathExists(patchPath))) {
    throw new Error(`Latest run has no patch.diff: ${latest}`);
  }
  logger.info(`Latest patch: ${patchPath}`);
  if (!(await askConfirm("Revert this patch?", false))) {
    logger.warn("Revert cancelled.");
    return;
  }
  await revertPatch(root, patchPath);
  logger.success("Patch reverted.");
}
