import { describe, expect, it } from "vitest";
import { formatExternalServices, parseServiceCommand } from "../src/tools/external-service.js";

describe("external service commands", () => {
  it("parses list services commands", () => {
    expect(parseServiceCommand("code-agent list-services")).toEqual({ kind: "list", port: undefined });
    expect(parseServiceCommand("code-agent list-services 8000")).toEqual({ kind: "list", port: 8000 });
  });

  it("parses stop service commands", () => {
    expect(parseServiceCommand("code-agent stop-service 12345")).toEqual({ kind: "stop", pid: 12345 });
  });

  it("ignores arbitrary shell commands", () => {
    expect(parseServiceCommand("kill 12345")).toBeUndefined();
    expect(parseServiceCommand("lsof -i :8000")).toBeUndefined();
  });

  it("formats services compactly and deduplicates ipv4 ipv6 rows", () => {
    const output = formatExternalServices([
      { pid: 724, command: "ControlCe", port: 7000, raw: "ipv4 row" },
      { pid: 724, command: "ControlCe", port: 7000, raw: "ipv6 row" },
      { pid: 1014, command: "mosquitto", port: 1883, raw: "mqtt row" }
    ]);

    expect(output).toContain("PID");
    expect(output).toContain("724");
    expect(output.match(/ControlCe/g)?.length).toBe(1);
    expect(output).not.toContain("raw=");
  });
});
