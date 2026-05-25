import { describe, expect, it } from "vitest";
import { canReadFile, canWriteFile } from "../src/safety/file-policy.js";
import { isDangerousCommand, requiresInstallConfirmation } from "../src/safety/command-policy.js";
import { redactSecrets } from "../src/safety/secrets.js";

describe("safety policies", () => {
  it("blocks sensitive reads and writes", () => {
    expect(canReadFile(".env")).toBe(false);
    expect(canReadFile(".ssh/id_rsa")).toBe(false);
    expect(canWriteFile("dist/cli.js")).toBe(false);
    expect(canWriteFile("venv/bin/python")).toBe(false);
    expect(canWriteFile(".venv/bin/python")).toBe(false);
    expect(canWriteFile("src/cli.ts")).toBe(true);
  });

  it("classifies unsafe commands", () => {
    expect(isDangerousCommand("git push origin main")).toBe(true);
    expect(isDangerousCommand("npm test")).toBe(false);
    expect(requiresInstallConfirmation("pnpm install")).toBe(true);
  });

  it("redacts supported provider API key environment variables", () => {
    expect(redactSecrets("ANTHROPIC_API_KEY=secret GEMINI_API_KEY=secret")).toBe("[REDACTED] [REDACTED]");
  });
});
