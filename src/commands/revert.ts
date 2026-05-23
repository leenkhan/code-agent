import path from "node:path";
import fs from "fs-extra";
import { askConfirm } from "../ui/confirm.js";
import { logger } from "../ui/logger.js";
import { latestRun } from "../state/run-store.js";
import { revertPatch } from "../patch/revert.js";

async function latestPatchPath(runDir: string): Promise<string | undefined> {
  const entries = await fs.readdir(runDir);
  const diffFiles = await Promise.all(entries
    .filter((entry) => entry.endsWith(".diff"))
    .map(async (entry) => {
      const filePath = path.join(runDir, entry);
      const stat = await fs.stat(filePath);
      return { filePath, mtimeMs: stat.mtimeMs };
    }));
  diffFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return diffFiles.at(-1)?.filePath;
}

export async function revertCommand(root: string): Promise<void> {
  const latest = await latestRun(root);
  if (!latest) {
    throw new Error("No previous run found.");
  }
  const patchPath = await latestPatchPath(latest);
  if (!patchPath) {
    throw new Error(`Latest run has no patch artifacts: ${latest}`);
  }
  logger.info(`Latest patch: ${patchPath}`);
  if (!(await askConfirm("Revert this patch?", false))) {
    logger.warn("Revert cancelled.");
    return;
  }
  await revertPatch(root, patchPath);
  logger.success("Patch reverted.");
}
