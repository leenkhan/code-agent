import path from "node:path";
import { execa } from "execa";

export type PatchCheckResult = {
  ok: boolean;
  error?: string;
};

export async function checkPatchApplies(root: string, patchPath: string): Promise<PatchCheckResult> {
  const result = await execa("git", ["apply", "--check", path.resolve(patchPath)], { cwd: root, reject: false });
  if (result.exitCode !== 0) {
    return { ok: false, error: result.stderr || result.stdout || "git apply --check failed" };
  }
  return { ok: true };
}

export async function applyPatch(root: string, patchPath: string): Promise<void> {
  const result = await execa("git", ["apply", path.resolve(patchPath)], { cwd: root, reject: false });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || "git apply failed");
  }
}
