import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appVersion } from "../src/version.js";

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
    expect(packageJson.version).toBe("0.3.3");
    expect(appVersion).toBe(packageJson.version);
    expect(packageJson.bin).toEqual({ codeshit: "dist/cli.js" });
    expect(packageJson.bin["code-agent"]).toBeUndefined();
    expect(packageJson.publishConfig?.access).toBe("public");
    expect(packageJson.license).toBe("MIT");
  });
});
