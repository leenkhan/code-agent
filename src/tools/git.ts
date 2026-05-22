import simpleGit from "simple-git";
import { execa } from "execa";

export async function isGitAvailable(): Promise<boolean> {
  try {
    const result = await execa("git", ["--version"], { reject: false });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

export async function isGitRepo(root: string): Promise<boolean> {
  try {
    return await simpleGit(root).checkIsRepo();
  } catch {
    return false;
  }
}

export async function gitStatus(root: string): Promise<string> {
  try {
    return await simpleGit(root).raw(["status", "--short"]);
  } catch {
    return "";
  }
}

export async function gitDiff(root: string): Promise<string> {
  try {
    return await simpleGit(root).diff();
  } catch {
    return "";
  }
}
