import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("package metadata", () => {
  it("publishes only the codeshit binary", async () => {
    const packageJson = JSON.parse(await fs.readFile(path.join(process.cwd(), "package.json"), "utf8")) as {
      name: string;
      version: string;
      bin: Record<string, string>;
      publishConfig?: { access?: string };
      license?: string;
    };

    expect(packageJson.name).toBe("@codeshit/cli");
    expect(packageJson.version).toBe("0.3.1-beta.0");
    expect(packageJson.bin).toEqual({ codeshit: "./dist/cli.js" });
    expect(packageJson.bin["code-agent"]).toBeUndefined();
    expect(packageJson.publishConfig?.access).toBe("public");
    expect(packageJson.license).toBe("MIT");
  });
});
