import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { analyzeEnvironmentFailures, formatEnvironmentIssue, formatExistingProjectState, inspectExistingProject, isPlanExitShortcutKey, parseChatInput, shouldAttemptEnvironmentFix } from "../src/commands/chat.js";
import { ChatTerminal, renderChatFrame } from "../src/ui/chat-tui.js";
import { displayWidth, renderMarkdown, stripAnsiCodes } from "../src/ui/markdown.js";
import { actionFromConfirmation } from "../src/ui/selection.js";
import { deriveChatMode, formatStatusBar } from "../src/ui/status-bar.js";

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

describe("chat status display", () => {
  it("derives mode from chat state", () => {
    expect(deriveChatMode({})).toBe("chat");
    expect(deriveChatMode({ planModeActive: true })).toBe("plan");
    expect(deriveChatMode({ planModeActive: true, executing: true })).toBe("execute");
  });

  it("formats a compact status bar", () => {
    const line = formatStatusBar({
      model: "deepseek-v4-pro",
      projectRoot: "/tmp/example",
      mode: "plan",
      state: "thinking"
    }, 80);

    const visible = line.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
    expect(visible).toBe("deepseek-v4-pro      /tmp/example     plan mode".padEnd(80));
    expect(line).toContain("\u001b[33mdeepseek-v4-pro\u001b[0m");
    expect(line).toContain("\u001b[32m/tmp/example\u001b[0m");
    expect(line).toContain("\u001b[35mplan\u001b[0m mode");
  });

  it("renders a fixed three-line input area above the status bar", () => {
    const lines = renderChatFrame({
      history: ["assistant: ready"],
      inputLabel: "you",
      inputValue: "apply patch",
      selection: {
        message: "Apply patch?",
        index: 0,
        choices: [
          { value: "proceed", name: "Apply patch" },
          { value: "cancel", name: "Cancel" }
        ]
      },
      status: {
        model: "deepseek-v4-pro",
        projectRoot: "/tmp/example",
        mode: "execute",
        state: "confirming"
      },
      columns: 80,
      rows: 8
    });

    expect(lines).toHaveLength(8);
    expect(lines.at(1)?.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")).toBe("you> apply patch".padEnd(80));
    expect(lines.at(2)?.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")).toBe("".padEnd(80));
    expect(lines.at(3)?.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")).toBe("".padEnd(80));
    expect(lines.at(-4)).toContain("? Apply patch?");
    expect(lines.at(-1)?.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")).toContain("execute mode");
    expect(lines.at(-1)?.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")).not.toContain("confirming");
  });

  it("wraps long Chinese history lines to the terminal width", () => {
    const lines = renderChatFrame({
      history: ["assistant: 这是一个很长的中文段落，用来验证终端宽字符换行不会超过窗口宽度。"],
      inputLabel: "you",
      inputValue: "",
      status: {
        model: "模型",
        projectRoot: "/tmp/example",
        mode: "chat",
        state: "idle"
      },
      columns: 24,
      rows: 8
    });

    expect(lines).toHaveLength(8);
    expect(lines.every((line) => displayWidth(line) === 24)).toBe(true);
  });

  it("keeps ANSI escape sequences intact when wrapping styled long lines", () => {
    const styled = `assistant: \u001b[1m${"abcdef".repeat(8)}\u001b[0m`;
    const lines = renderChatFrame({
      history: [styled],
      inputLabel: "you",
      inputValue: "",
      status: {
        model: "deepseek-v4-pro",
        projectRoot: "/tmp/example",
        mode: "chat",
        state: "idle"
      },
      columns: 20,
      rows: 7
    });

    expect(lines.every((line) => displayWidth(line) === 20)).toBe(true);
    expect(lines.join("\n")).not.toMatch(/\u001b\[[0-9;?]*[ -/]*$/m);
  });

  it("renders wide assistant markdown tables within the chat frame width", () => {
    const markdown = renderMarkdown([
      "| 项目 | 评分 | 状态 |",
      "| --- | --- | --- |",
      "| 登录 | ⭐⭐⭐ | 完成 |",
      "| 部署 | ✅ | 进行中 |"
    ].join("\n"));
    const lines = renderChatFrame({
      history: markdown.split("\n"),
      inputLabel: "you",
      inputValue: "",
      status: {
        model: "deepseek-v4-pro",
        projectRoot: "/tmp/example",
        mode: "chat",
        state: "idle"
      },
      columns: 28,
      rows: 12
    });
    const visible = stripAnsiCodes(lines.join("\n"));

    expect(visible).toContain("│ 登录 │ ⭐⭐⭐");
    expect(visible).toContain("│ 部署 │ ✅");
    expect(visible).not.toContain("| --- |");
    expect(lines.every((line) => displayWidth(line) === 28)).toBe(true);
  });
});

describe("chat terminal lifecycle", () => {
  it("renders assistant markdown separately from raw log output", () => {
    const stdin = new PassThrough() as PassThrough & {
      isTTY: true;
      isRaw: boolean;
      setRawMode(mode: boolean): void;
    };
    const stdout = new PassThrough() as PassThrough & {
      isTTY: true;
      columns: number;
      rows: number;
      cursorTo?(x: number, y?: number): boolean;
      clearScreenDown?(): boolean;
    };
    stdin.isTTY = true;
    stdin.isRaw = false;
    stdin.setRawMode = (mode: boolean) => {
      stdin.isRaw = mode;
    };
    stdout.isTTY = true;
    stdout.columns = 100;
    stdout.rows = 20;

    const terminal = new ChatTerminal({
      model: "deepseek-v4-pro",
      projectRoot: "/tmp/example",
      mode: "chat",
      state: "idle"
    }, {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream
    });

    terminal.start();
    terminal.appendMarkdown(["| A | B |", "| --- | --- |", "| one | two |"].join("\n"));
    terminal.append(["| Raw | Log |", "| --- | --- |"].join("\n"));
    terminal.stop();

    const visible = stdout.read()?.toString("utf8").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "") ?? "";
    expect(visible).toContain("┌─────┬─────┐");
    expect(visible).toContain("│ one │ two │");
    expect(visible).toContain("| Raw | Log |");
    expect(visible).toContain("| --- | --- |");
  });

  it("restores raw mode and pauses stdin on stop", () => {
    const stdin = new PassThrough() as PassThrough & {
      isTTY: true;
      isRaw: boolean;
      setRawMode(mode: boolean): void;
    };
    const stdout = new PassThrough() as PassThrough & {
      isTTY: true;
      columns: number;
      rows: number;
      cursorTo?(x: number, y?: number): boolean;
      clearScreenDown?(): boolean;
    };
    stdin.isTTY = true;
    stdin.isRaw = false;
    stdin.setRawMode = (mode: boolean) => {
      stdin.isRaw = mode;
    };
    stdout.isTTY = true;
    stdout.columns = 80;
    stdout.rows = 12;

    const terminal = new ChatTerminal({
      model: "deepseek-v4-pro",
      projectRoot: "/tmp/example",
      mode: "chat",
      state: "idle"
    }, {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream
    });

    terminal.start();
    expect(stdin.isRaw).toBe(true);
    terminal.stop();
    expect(stdin.isRaw).toBe(false);
    expect(stdin.isPaused()).toBe(true);
  });
});

describe("confirmation action parsing", () => {
  it("maps simple yes/no fallback answers to explicit actions", () => {
    expect(actionFromConfirmation(true)).toBe("proceed");
    expect(actionFromConfirmation(false)).toBe("cancel");
    expect(actionFromConfirmation(false, [
      { value: "proceed", name: "Run" },
      { value: "skip", name: "Skip" }
    ])).toBe("skip");
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
        ".codeshit/runs/latest.json"
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
