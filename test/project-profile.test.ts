import { describe, expect, it } from "vitest";
import {
  buildProjectProfile,
  classifyEnvironmentFailures,
  detectValidationCommandsFromProfile,
  isLongRunningCommandForProfile,
  shouldAttemptEnvironmentFix
} from "../src/project/profile.js";
import type { ProjectLanguage } from "../src/types.js";

type ProfileCase = {
  language: ProjectLanguage;
  files: string[];
  packageJson?: { scripts?: Record<string, string> };
  expectedCommands: string[];
};

describe("project profile detection", () => {
  const profileCases: ProfileCase[] = [
    {
      language: "typescript",
      files: ["package.json", "pnpm-lock.yaml", "tsconfig.json", "src/index.ts"],
      packageJson: { scripts: { build: "tsc", test: "vitest", lint: "eslint ." } },
      expectedCommands: ["pnpm run build", "pnpm test", "pnpm run lint"]
    },
    {
      language: "javascript",
      files: ["package.json", "yarn.lock", "src/index.js"],
      packageJson: { scripts: { test: "node --test" } },
      expectedCommands: ["yarn test"]
    },
    {
      language: "python",
      files: ["pyproject.toml", "src/app.py", "tests/test_app.py"],
      expectedCommands: ["uv run pytest", "python -m pytest"]
    },
    {
      language: "go",
      files: ["go.mod", "cmd/api/main.go"],
      expectedCommands: ["go test ./..."]
    },
    {
      language: "rust",
      files: ["Cargo.toml", "src/lib.rs"],
      expectedCommands: ["cargo test"]
    },
    {
      language: "java",
      files: ["pom.xml", "src/main/java/App.java"],
      expectedCommands: ["mvn test"]
    },
    {
      language: "kotlin",
      files: ["build.gradle.kts", "src/main/kotlin/App.kt"],
      expectedCommands: ["gradle test"]
    },
    {
      language: "swift",
      files: ["Package.swift", "Sources/App/App.swift"],
      expectedCommands: ["swift test"]
    },
    {
      language: "php",
      files: ["composer.json", "phpunit.xml", "src/App.php"],
      expectedCommands: ["composer test", "vendor/bin/phpunit"]
    },
    {
      language: "ruby",
      files: ["Gemfile", "spec/app_spec.rb"],
      expectedCommands: ["bundle exec rspec", "ruby -Itest"]
    },
    {
      language: "csharp",
      files: ["App.csproj", "Program.cs"],
      expectedCommands: ["dotnet test"]
    }
  ];

  it.each(profileCases)("profiles $language projects and infers validation commands", ({ language, files, packageJson, expectedCommands }) => {
    const profile = buildProjectProfile(files);
    const commands = detectValidationCommandsFromProfile(profile, files, packageJson);

    expect(profile.languages).toContain(language);
    expect(commands).toEqual(expect.arrayContaining(expectedCommands));
  });

  it("uses source globs as profile evidence, including nested brace and globstar patterns", () => {
    const typescriptProfile = buildProjectProfile(["src/features/user/index.tsx"]);
    const goProfile = buildProjectProfile(["cmd/api/main.go"]);

    expect(typescriptProfile.languages).toContain("typescript");
    expect(goProfile.languages).toContain("go");
  });

  it("prefers project wrappers when complete and falls back when wrappers are incomplete", () => {
    const mavenWithWrapper = buildProjectProfile(["pom.xml", "mvnw", ".mvn/wrapper/maven-wrapper.jar"]);
    const mavenWithoutWrapperJar = buildProjectProfile(["pom.xml", "mvnw"]);
    const gradleWithWrapper = buildProjectProfile(["build.gradle", "gradlew"]);

    expect(detectValidationCommandsFromProfile(mavenWithWrapper, mavenWithWrapper.importantFiles)).toContain("./mvnw test");
    expect(detectValidationCommandsFromProfile(mavenWithoutWrapperJar, ["pom.xml", "mvnw"])).toContain("mvn test");
    expect(detectValidationCommandsFromProfile(gradleWithWrapper, ["build.gradle", "gradlew"])).toContain("./gradlew test");
  });

  it("classifies missing tools as environment blockers across supported non-JS toolchains", () => {
    const cases = [
      { language: "python", files: ["pyproject.toml"], command: "pytest", stderr: "/bin/sh: pytest: command not found" },
      { language: "go", files: ["go.mod"], command: "go test ./...", stderr: "/bin/sh: go: command not found" },
      { language: "rust", files: ["Cargo.toml"], command: "cargo test", stderr: "/bin/sh: cargo: command not found" },
      { language: "java", files: ["pom.xml"], command: "mvn test", stderr: "/bin/sh: mvn: command not found" },
      { language: "kotlin", files: ["build.gradle.kts"], command: "gradle test", stderr: "/bin/sh: gradle: command not found" },
      { language: "swift", files: ["Package.swift"], command: "swift test", stderr: "/bin/sh: swift: command not found" },
      { language: "php", files: ["composer.json"], command: "composer test", stderr: "/bin/sh: composer: command not found" },
      { language: "ruby", files: ["Gemfile"], command: "bundle exec rspec", stderr: "/bin/sh: bundle: command not found" },
      { language: "csharp", files: ["App.csproj"], command: "dotnet test", stderr: "/bin/sh: dotnet: command not found" }
    ] satisfies Array<{ language: ProjectLanguage; files: string[]; command: string; stderr: string }>;

    for (const item of cases) {
      const profile = buildProjectProfile(item.files);
      const issue = classifyEnvironmentFailures([{
        command: item.command,
        exitCode: 127,
        stdout: "",
        stderr: item.stderr
      }], profile);

      expect(profile.languages, item.language).toContain(item.language);
      expect(issue?.kind, item.language).toBe("missing_command");
      expect(issue?.summary, item.language).toContain("local development environment");
    }
  });

  it("classifies wrappers, dependency downloads, permissions, services, compilers, and tests consistently", () => {
    const profile = buildProjectProfile(["pom.xml"]);

    expect(classifyEnvironmentFailures([{ command: "./mvnw test", exitCode: 127, stdout: "", stderr: "No such file or directory" }], profile)?.kind).toBe("missing_wrapper");
    expect(classifyEnvironmentFailures([{ command: "mvn test", exitCode: 1, stdout: "", stderr: "Could not resolve dependencies" }], profile)?.kind).toBe("dependency_download_failure");
    expect(classifyEnvironmentFailures([{ command: "cargo test", exitCode: 1, stdout: "", stderr: "Permission denied accessing cargo registry" }], buildProjectProfile(["Cargo.toml"]))?.kind).toBe("permission_issue");
    expect(classifyEnvironmentFailures([{ command: "curl http://localhost:8080", exitCode: 7, stdout: "", stderr: "curl: (7) Failed to connect" }], profile)?.kind).toBe("service_not_started");
    expect(classifyEnvironmentFailures([{ command: "go test ./...", exitCode: 1, stdout: "", stderr: "syntax error: unexpected name" }], buildProjectProfile(["go.mod"]))?.kind).toBe("compile_failed");
    expect(classifyEnvironmentFailures([{ command: "dotnet test", exitCode: 1, stdout: "Tests failed: 1", stderr: "" }], buildProjectProfile(["App.csproj"]))?.kind).toBe("test_failed");
  });

  it("only attempts automatic environment fixes for project wrapper files", () => {
    const profile = buildProjectProfile(["pyproject.toml"]);
    const missingPython = classifyEnvironmentFailures([{
      command: "python -m pytest",
      exitCode: 127,
      stdout: "",
      stderr: "/bin/sh: python: command not found"
    }], profile);
    const missingWrapper = classifyEnvironmentFailures([{
      command: "./mvnw test",
      exitCode: 127,
      stdout: "",
      stderr: "No such file or directory"
    }], buildProjectProfile(["pom.xml"]));

    expect(missingPython?.kind).toBe("missing_command");
    expect(missingPython?.suggestions.join("\n")).toContain("python3");
    expect(shouldAttemptEnvironmentFix(missingPython!)).toBe(false);
    expect(missingWrapper?.kind).toBe("missing_wrapper");
    expect(shouldAttemptEnvironmentFix(missingWrapper!)).toBe(true);
  });

  it("detects long-running start commands from the active profile", () => {
    expect(isLongRunningCommandForProfile("swift run", buildProjectProfile(["Package.swift"]))).toBe(true);
    expect(isLongRunningCommandForProfile("dotnet run", buildProjectProfile(["App.csproj"]))).toBe(true);
    expect(isLongRunningCommandForProfile("go test ./...", buildProjectProfile(["go.mod"]))).toBe(false);
  });
});
