import { describe, expect, it } from "vitest";
import { compactOutput, formatCompactCommandResult } from "../src/ui/command-output.js";

describe("command output formatting", () => {
  it("filters noisy pip output and keeps useful lines", () => {
    const output = compactOutput([
      "Looking in indexes: http://example/simple/",
      "Requirement already satisfied: fastapi in /x",
      "Collecting greenlet>=1",
      "Successfully installed greenlet-3.5.1",
      "[notice] A new release of pip is available"
    ].join("\n"));

    expect(output).toContain("Collecting greenlet");
    expect(output).toContain("Successfully installed");
    expect(output).not.toContain("Requirement already satisfied");
    expect(output).not.toContain("[notice]");
  });

  it("limits long command result output", () => {
    const result = formatCompactCommandResult({
      command: "example",
      exitCode: 0,
      stdout: Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n"),
      stderr: ""
    });

    expect(result).toContain("... 14 more line(s) hidden");
  });

  it("keeps important install lines and suppresses noise", () => {
    const output = compactOutput([
      "Looking in indexes: http://example/simple/",
      "Requirement already satisfied: fastapi in /x",
      "Collecting greenlet>=1",
      "Downloading greenlet-3.5.1.whl (285 kB)",
      "Installing collected packages: greenlet",
      "Successfully installed greenlet-3.5.1",
      "[notice] A new release of pip is available"
    ].join("\n"));

    expect(output).toContain("Collecting greenlet");
    expect(output).toContain("Downloading greenlet");
    expect(output).toContain("Successfully installed");
    expect(output).not.toContain("Requirement already satisfied");
    expect(output).not.toContain("[notice]");
  });
});
