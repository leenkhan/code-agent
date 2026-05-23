import { describe, expect, it } from "vitest";
import { isLongRunningCommand, parseStopBackgroundCommand, pruneStoppedCommands } from "../src/tools/background-command.js";

describe("background command helpers", () => {
  it("detects long-running development commands", () => {
    expect(isLongRunningCommand("uvicorn fastapi_app.main:app --reload")).toBe(true);
    expect(isLongRunningCommand("pnpm dev")).toBe(true);
    expect(isLongRunningCommand("pip install -r requirements.txt")).toBe(false);
  });

  it("parses model-returned stop commands", () => {
    expect(parseStopBackgroundCommand("codeshit stop-background 1")).toBe(1);
    expect(parseStopBackgroundCommand("codeshit stop-background all")).toBe("all");
    expect(parseStopBackgroundCommand("停止服务")).toBeUndefined();
  });

  it("prunes commands marked as stopped", () => {
    const fake = {
      id: 1,
      command: "uvicorn app:app --reload",
      process: { exitCode: null, killed: false },
      startedAt: new Date(),
      stopped: true
    };
    expect(pruneStoppedCommands([fake as never])).toEqual([]);
  });
});
