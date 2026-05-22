import { describe, expect, it } from "vitest";
import { analyzeEnvironmentFailures, formatEnvironmentIssue, formatExistingProjectState, inspectExistingProject, parseChatInput } from "../src/commands/chat.js";

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

describe("environment failure analysis", () => {
  it("detects missing Gradle instead of treating it as a code repair", () => {
    const issue = analyzeEnvironmentFailures([
      {
        command: "gradle wrapper",
        exitCode: 127,
        stdout: "",
        stderr: "/bin/sh: gradle: command not found",
        durationMs: 19
      }
    ]);

    expect(issue?.details.join("\n")).toContain("gradle");
    expect(formatEnvironmentIssue(issue!)).toContain("Install Gradle first");
  });

  it("detects missing Gradle wrapper and downstream curl service failures", () => {
    const issue = analyzeEnvironmentFailures([
      {
        command: "./gradlew build",
        exitCode: 127,
        stdout: "",
        stderr: "/bin/sh: ./gradlew: No such file or directory",
        durationMs: 16
      },
      {
        command: "curl http://localhost:8080/login",
        exitCode: 7,
        stdout: "",
        stderr: "curl: (7) Failed to connect to localhost port 8080 after 0 ms: Couldn't connect to server",
        durationMs: 31
      }
    ]);

    const formatted = formatEnvironmentIssue(issue!);
    expect(formatted).toContain("Gradle wrapper is missing");
    expect(formatted).toContain("Service was not reachable");
    expect(formatted).toContain("Skip service startup and curl tests");
  });
});

describe("existing project inspection", () => {
  it("detects project markers and source files before scaffolding", () => {
    const state = inspectExistingProject({
      root: "/tmp/project",
      fileTree: [
        "build.gradle.kts",
        "settings.gradle.kts",
        "src/main/kotlin/com/example/App.kt",
        ".code-agent/runs/latest.json"
      ],
      importantFiles: []
    });

    expect(state?.markers).toEqual([
      "build.gradle.kts",
      "settings.gradle.kts",
      "src/main/kotlin/com/example/App.kt"
    ]);
    expect(state?.sourceFiles).toEqual(["src/main/kotlin/com/example/App.kt"]);
    expect(formatExistingProjectState(state!)).toContain("Existing project files detected");
  });

  it("does not warn for an empty directory", () => {
    expect(inspectExistingProject({ root: "/tmp/project", fileTree: [], importantFiles: [] })).toBeUndefined();
  });
});
