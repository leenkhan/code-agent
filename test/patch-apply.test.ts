import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { checkPatchApplies } from "../src/patch/apply.js";

async function createGitRepo(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "code-agent-patch-"));
  await execa("git", ["init"], { cwd: root });
  await fs.writeFile(path.join(root, "README.md"), "old\n", "utf8");
  await execa("git", ["add", "README.md"], { cwd: root });
  await execa("git", ["commit", "-m", "initial"], {
    cwd: root,
    env: {
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com"
    }
  });
  return root;
}

describe("checkPatchApplies", () => {
  it("accepts a git-applicable patch", async () => {
    const root = await createGitRepo();
    const patchPath = path.join(root, "patch.diff");
    await fs.writeFile(
      patchPath,
      `diff --git a/README.md b/README.md
index 3367afd..3e75765 100644
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old
+new
`,
      "utf8"
    );

    await expect(checkPatchApplies(root, patchPath)).resolves.toEqual({ ok: true });
  });

  it("rejects a malformed patch that passes shallow diff checks", async () => {
    const root = await createGitRepo();
    const patchPath = path.join(root, "patch.diff");
    await fs.writeFile(
      patchPath,
      `diff --git a/example.txt b/example.txt
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/example.txt
@@ -0,0 +1,3 @@
+one
+two
`,
      "utf8"
    );

    const result = await checkPatchApplies(root, patchPath);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("corrupt patch");
  });
});
