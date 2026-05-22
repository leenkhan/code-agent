import { describe, expect, it } from "vitest";
import { analyzeEnvironmentFailures, formatEnvironmentIssue, formatExistingProjectState, inspectExistingProject, isPlanExitShortcutKey, parseChatInput, shouldAttemptEnvironmentFix } from "../src/commands/chat.js";

describe("parseChatInput", () => {
  it("parses control commands", () => {
    expect(parseChatInput(" /help ")).toEqual({ kind: "help" });
    expect(parseChatInput("/exit")).toEqual({ kind: "exit" });
    expect(parseChatInput("/quit")).toEqual({ kind: "exit" });
    expect(parseChatInput("/clear")).toEqual({ kind: "clear" });
    expect(parseChatInput("/doctor")).toEqual({ kind: "doctor" });
    expect(parseChatInput("/diff")).toEqual({ kind: "diff" });
    expect(parseChatInput("/plan")).toEqual({ kind: "plan" });
    expect(parseChatInput("/plan add login")).toEqual({ kind: "plan", task: "add login" });
    expect(parseChatInput("/plan exit")).toEqual({ kind: "plan_exit" });
    expect(parseChatInput("/plan   exit")).toEqual({ kind: "plan_exit" });
    expect(parseChatInput("/apply-plan")).toEqual({ kind: "apply_plan" });
  });

  it("treats normal input as a chat message", () => {
    expect(parseChatInput("这个项目是做什么的？")).toEqual({
      kind: "message",
      message: "这个项目是做什么的？"
    });
  });

  it("treats unknown slash-prefixed input as a chat command error", () => {
    expect(parseChatInput("/run update readme")).toEqual({
      kind: "unknown_command",
      command: "/run"
    });
    expect(parseChatInput("/xxx")).toEqual({
      kind: "unknown_command",
      command: "/xxx"
    });
  });
});

describe("plan mode shortcuts", () => {
  it("detects Shift+Tab escape sequences as plan exit shortcuts", () => {
    expect(isPlanExitShortcutKey({ name: "tab", shift: true })).toBe(true);
    expect(isPlanExitShortcutKey({ sequence: "\u001b[Z" })).toBe(true);
    expect(isPlanExitShortcutKey({ name: "tab" })).toBe(false);
    expect(isPlanExitShortcutKey({ name: "enter" })).toBe(false);
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

  it("diagnoses combined java and Gradle wrapper prerequisite checks precisely", () => {
    const issue = analyzeEnvironmentFailures([
      {
        command: "java -version && ./gradlew --version",
        exitCode: 127,
        stdout: "",
        stderr: [
          'java version "1.8.0_241"',
          "Java(TM) SE Runtime Environment (build 1.8.0_241-b07)",
          "Java HotSpot(TM) 64-Bit Server VM (build 25.241-b07, mixed mode)",
          "zsh: no such file or directory: ./gradlew"
        ].join("\n"),
        durationMs: 1780
      }
    ]);

    const formatted = formatEnvironmentIssue(issue!);
    expect(formatted).toContain("Java 8 was detected");
    expect(formatted).toContain('Gradle wrapper is missing for "./gradlew --version" from "java -version && ./gradlew --version"');
    expect(formatted).toContain("JDK 17");
  });

  it("stops follow-up commands when the start command is skipped or blocked", () => {
    const issue = analyzeEnvironmentFailures([
      {
        command: "curl http://localhost:8080/api/auth/register",
        exitCode: 7,
        stdout: "",
        stderr: "curl: (7) Failed to connect to localhost port 8080 after 0 ms: Couldn't connect to server",
        durationMs: 44
      }
    ]);

    expect(issue?.details.join("\n")).toContain("Service was not reachable");
  });

  it("detects corrupt Maven wrapper jar as an environment issue", () => {
    const issue = analyzeEnvironmentFailures([
      {
        command: "./mvnw test",
        exitCode: 1,
        stdout: "",
        stderr: "Error: Invalid or corrupt jarfile /Users/smb/.m2/wrapper/dists/maven-wrapper/3.9.6/maven-wrapper-3.9.6.jar",
        durationMs: 31
      }
    ]);

    const formatted = formatEnvironmentIssue(issue!);
    expect(formatted).toContain("Maven wrapper jar is invalid or corrupt");
    expect(formatted).toContain("system Maven is available");
  });

  it("detects Maven local repository write failures as environment issues", () => {
    const issue = analyzeEnvironmentFailures([
      {
        command: "mvn test",
        exitCode: 1,
        stdout: "",
        stderr: [
          "[WARNING] Failed to create parent directories for tracking file /Users/smb/.m2/repository/org/xerial/sqlite-jdbc/3.42.0.0/sqlite-jdbc-3.42.0.0.pom.lastUpdated",
          "[ERROR] Could not transfer artifact org.xerial:sqlite-jdbc:pom:3.42.0.0: /Users/smb/.m2/repository/org/xerial/sqlite-jdbc/3.42.0.0/sqlite-jdbc-3.42.0.0.pom.part.lock (No such file or directory)"
        ].join("\n"),
        durationMs: 3867
      }
    ]);

    const formatted = formatEnvironmentIssue(issue!);
    expect(formatted).toContain("Maven could not write to the local repository");
    expect(formatted).toContain("mvn -Dmaven.repo.local=/tmp/m2 test");
  });

  it("detects Maven plugin and dependency resolution failures during spring-boot:run", () => {
    const issue = analyzeEnvironmentFailures([
      {
        command: "mvn spring-boot:run",
        exitCode: 1,
        stdout: "",
        stderr: [
          "[ERROR] Failed to execute goal org.springframework.boot:spring-boot-maven-plugin:2.7.18:run",
          "[ERROR] Could not transfer artifact org.springframework.boot:spring-boot-buildpack-platform:jar:2.7.18 from/to aliyun",
          "[ERROR] Could not resolve dependencies for project com.example:demo:jar:0.0.1-SNAPSHOT"
        ].join("\n"),
        durationMs: 5221
      }
    ]);

    const formatted = formatEnvironmentIssue(issue!);
    expect(formatted).toContain("Maven could not resolve or download dependencies/plugins");
    expect(formatted).toContain("Spring Boot plugin resolution failed");
    expect(shouldAttemptEnvironmentFix(issue!)).toBe(false);
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
