import { describe, expect, it } from "vitest";
import { validatePatch } from "../src/patch/validate.js";

describe("validatePatch", () => {
  it("accepts a simple unified diff", () => {
    const diff = `diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1 +1 @@
-old
+new
`;
    expect(validatePatch(diff).ok).toBe(true);
  });

  it("rejects non-diff output", () => {
    expect(validatePatch("hello").ok).toBe(false);
  });

  it("rejects forbidden write paths", () => {
    const diff = `diff --git a/.env b/.env
--- a/.env
+++ b/.env
@@ -1 +1 @@
-A=1
+A=2
`;
    expect(validatePatch(diff).ok).toBe(false);
  });
});
