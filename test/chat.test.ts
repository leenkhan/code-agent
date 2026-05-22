import { describe, expect, it } from "vitest";
import { parseChatInput } from "../src/commands/chat.js";

describe("parseChatInput", () => {
  it("parses control commands", () => {
    expect(parseChatInput(" /help ")).toEqual({ kind: "help" });
    expect(parseChatInput("/exit")).toEqual({ kind: "exit" });
    expect(parseChatInput("/quit")).toEqual({ kind: "exit" });
    expect(parseChatInput("/clear")).toEqual({ kind: "clear" });
    expect(parseChatInput("/doctor")).toEqual({ kind: "doctor" });
    expect(parseChatInput("/diff")).toEqual({ kind: "diff" });
  });

  it("treats normal input as a chat message", () => {
    expect(parseChatInput("这个项目是做什么的？")).toEqual({
      kind: "message",
      message: "这个项目是做什么的？"
    });
  });

  it("does not expose hidden implementation slash commands", () => {
    expect(parseChatInput("/run update readme")).toEqual({
      kind: "message",
      message: "/run update readme"
    });
  });
});
