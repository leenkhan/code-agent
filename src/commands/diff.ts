import path from "node:path";
import fs from "fs-extra";
import { gitDiff } from "../tools/git.js";
import { latestRun } from "../state/run-store.js";
import { logger } from "../ui/logger.js";

async function listPatchArtifacts(runDir: string): Promise<Array<{ filePath: string; mtimeMs: number }>> {
  const entries = await fs.readdir(runDir);
  const patchFiles = await Promise.all(entries
    .filter((entry) => entry.endsWith(".diff"))
    .map(async (entry) => {
      const filePath = path.join(runDir, entry);
      const stat = await fs.stat(filePath);
      return { filePath, mtimeMs: stat.mtimeMs };
    }));
  return patchFiles.sort((a, b) => a.mtimeMs - b.mtimeMs);
}

export async function diffCommand(root: string): Promise<void> {
  logger.heading("Current git diff");
  logger.info(await gitDiff(root) || "(empty)");
  const latest = await latestRun(root);
  if (latest) {
    const patchFiles = await listPatchArtifacts(latest);
    const latestPatch = patchFiles.at(-1)?.filePath;
    logger.info(`Latest run: ${latest}`);
    logger.info(`Latest patch: ${latestPatch ?? "(none)"}`);
    if (patchFiles.length > 0) {
      logger.info("Patch history:");
      logger.info(patchFiles.map((entry) => `- ${entry.filePath}`).join("\n"));
    }
  }
}
