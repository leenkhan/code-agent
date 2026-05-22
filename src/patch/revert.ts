import path from "node:path";
import { execa } from "execa";

export async function revertPatch(root: string, patchPath: string): Promise<void> {
  const result = await execa("git", ["apply", "-R", path.resolve(patchPath)], { cwd: root, reject: false });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || "git apply -R failed");
  }
}
