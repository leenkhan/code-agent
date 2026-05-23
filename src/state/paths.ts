import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { logger } from "../ui/logger.js";

export const appName = "CodeShit";
export const commandName = "codeshit";
export const projectStateDirName = ".codeshit";
export const legacyProjectStateDirName = ".code-agent";
export const globalStateDirName = ".codeshit";
export const legacyGlobalStateDirName = ".code-agent";

const warnedConflicts = new Set<string>();

export function projectStateDir(root: string): string {
  return path.join(root, projectStateDirName);
}

export function legacyProjectStateDir(root: string): string {
  return path.join(root, legacyProjectStateDirName);
}

function homeDir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? os.homedir();
}

export function globalStateDir(): string {
  return path.join(homeDir(), globalStateDirName);
}

export function legacyGlobalStateDir(): string {
  return path.join(homeDir(), legacyGlobalStateDirName);
}

export async function migrateProjectState(root: string): Promise<void> {
  await migrateStateDir(legacyProjectStateDir(root), projectStateDir(root));
}

export async function migrateGlobalState(): Promise<void> {
  await migrateStateDir(legacyGlobalStateDir(), globalStateDir());
}

async function migrateStateDir(oldDir: string, newDir: string): Promise<void> {
  const oldExists = await fs.pathExists(oldDir);
  if (!oldExists) return;

  const newExists = await fs.pathExists(newDir);
  if (!newExists) {
    await fs.move(oldDir, newDir);
    logger.info(`Migrated ${oldDir} to ${newDir}.`);
    return;
  }

  const key = `${oldDir}->${newDir}`;
  if (!warnedConflicts.has(key)) {
    warnedConflicts.add(key);
    logger.warn(`Both ${oldDir} and ${newDir} exist. Using ${newDir}; ${oldDir} was left untouched.`);
  }
}
