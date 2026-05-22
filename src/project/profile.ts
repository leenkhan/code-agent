import path from "node:path";
import fg from "fast-glob";
import fs from "fs-extra";
import type { ImportantFile, ProjectContext, ProjectLanguage, ProjectProfile, ToolchainAdapter, ValidationStepType } from "../types.js";

export type EnvironmentIssueKind =
  | "missing_command"
  | "missing_wrapper"
  | "version_mismatch"
  | "dependency_download_failure"
  | "network_unavailable"
  | "permission_issue"
  | "service_not_started"
  | "compile_failed"
  | "test_failed"
  | "unknown";

export type EnvironmentIssue = {
  kind: EnvironmentIssueKind;
  summary: string;
  details: string[];
  suggestions: string[];
};

type AdapterDef = ToolchainAdapter & {
  preferredTestCommands: string[];
};

const adapters: AdapterDef[] = [
  {
    language: "typescript",
    displayName: "TypeScript",
    rootMarkers: ["package.json", "tsconfig.json"],
    importantFiles: ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "tsconfig.json"],
    sourceGlobs: ["*.{ts,tsx,mts,cts}", "src/**/*.{ts,tsx,mts,cts}", "test/**/*.{ts,tsx,mts,cts}"],
    capabilities: ["build", "test", "lint", "run", "install"],
    validationCommands: {
      build: ["npm run build", "pnpm build", "yarn build"],
      test: ["npm test", "pnpm test", "yarn test"],
      lint: ["npm run lint", "pnpm lint", "yarn lint"],
      run: ["npm run dev", "pnpm dev", "yarn dev"],
      install: ["npm install", "pnpm install", "yarn install"]
    },
    wrappers: [
      { type: "npm", command: "npm", requiredFiles: ["package.json"] },
      { type: "pnpm", command: "pnpm", requiredFiles: ["package.json"] },
      { type: "yarn", command: "yarn", requiredFiles: ["package.json"] }
    ],
    longRunningCommandPatterns: ["npm run dev", "pnpm dev", "yarn dev", "vite", "next dev"],
    environmentChecks: ["Node.js", "package manager", "lockfile"],
    preferredTestCommands: ["npm test", "pnpm test", "yarn test"]
  },
  {
    language: "javascript",
    displayName: "JavaScript",
    rootMarkers: ["package.json", "jsconfig.json"],
    importantFiles: ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "jsconfig.json"],
    sourceGlobs: ["*.{js,jsx,mjs,cjs}", "src/**/*.{js,jsx,mjs,cjs}", "test/**/*.{js,jsx,mjs,cjs}"],
    capabilities: ["build", "test", "lint", "run", "install"],
    validationCommands: {
      build: ["npm run build", "pnpm build", "yarn build"],
      test: ["npm test", "pnpm test", "yarn test"],
      lint: ["npm run lint", "pnpm lint", "yarn lint"],
      run: ["npm run dev", "pnpm dev", "yarn dev"],
      install: ["npm install", "pnpm install", "yarn install"]
    },
    wrappers: [
      { type: "npm", command: "npm", requiredFiles: ["package.json"] },
      { type: "pnpm", command: "pnpm", requiredFiles: ["package.json"] },
      { type: "yarn", command: "yarn", requiredFiles: ["package.json"] }
    ],
    longRunningCommandPatterns: ["npm run dev", "pnpm dev", "yarn dev", "vite", "next dev"],
    environmentChecks: ["Node.js", "package manager", "lockfile"],
    preferredTestCommands: ["npm test", "pnpm test", "yarn test"]
  },
  {
    language: "python",
    displayName: "Python",
    rootMarkers: ["pyproject.toml", "requirements.txt", "setup.py"],
    importantFiles: ["pyproject.toml", "requirements.txt", "setup.py", "uv.lock"],
    sourceGlobs: ["*.py", "src/**/*.py", "tests/**/*.py", "test/**/*.py"],
    capabilities: ["test", "run", "install"],
    validationCommands: {
      test: ["uv run pytest", "pytest", "python -m pytest"],
      run: ["python main.py", "python app.py"],
      install: ["pip install -r requirements.txt", "uv sync"]
    },
    wrappers: [{ type: "python", command: "python", requiredFiles: [] }],
    longRunningCommandPatterns: ["python -m uvicorn", "uvicorn", "fastapi dev"],
    environmentChecks: ["Python", "pip", "virtual environment"],
    preferredTestCommands: ["uv run pytest", "pytest", "python -m pytest"]
  },
  {
    language: "go",
    displayName: "Go",
    rootMarkers: ["go.mod"],
    importantFiles: ["go.mod", "go.sum"],
    sourceGlobs: ["*.go", "cmd/**/*.go", "internal/**/*.go", "tests/**/*.go"],
    capabilities: ["build", "test", "run"],
    validationCommands: {
      build: ["go build ./..."],
      test: ["go test ./..."],
      run: ["go run ."]
    },
    wrappers: [{ type: "go", command: "go", requiredFiles: ["go.mod"] }],
    longRunningCommandPatterns: ["go run .", "air"],
    environmentChecks: ["Go toolchain", "module cache"],
    preferredTestCommands: ["go test ./..."]
  },
  {
    language: "rust",
    displayName: "Rust",
    rootMarkers: ["Cargo.toml"],
    importantFiles: ["Cargo.toml", "Cargo.lock"],
    sourceGlobs: ["*.rs", "src/**/*.rs", "tests/**/*.rs"],
    capabilities: ["build", "test", "run"],
    validationCommands: {
      build: ["cargo build"],
      test: ["cargo test"],
      run: ["cargo run"]
    },
    wrappers: [{ type: "cargo", command: "cargo", requiredFiles: ["Cargo.toml"] }],
    longRunningCommandPatterns: ["cargo run"],
    environmentChecks: ["Rust toolchain", "cargo registry"],
    preferredTestCommands: ["cargo test"]
  },
  {
    language: "java",
    displayName: "Java",
    rootMarkers: ["pom.xml", "build.gradle", "build.gradle.kts"],
    importantFiles: ["pom.xml", "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts", ".mvn/wrapper/maven-wrapper.jar", "mvnw", "gradlew"],
    sourceGlobs: ["*.java", "src/**/*.java", "test/**/*.java"],
    capabilities: ["build", "test", "run"],
    validationCommands: {
      build: ["mvn test", "gradle test"],
      test: ["mvn test", "gradle test"],
      run: ["mvn spring-boot:run", "gradle bootRun"]
    },
    wrappers: [
      { type: "maven", command: "./mvnw", requiredFiles: ["pom.xml", ".mvn/wrapper/maven-wrapper.jar"], missingCommand: "mvn" },
      { type: "gradle", command: "./gradlew", requiredFiles: ["build.gradle", "build.gradle.kts"], missingCommand: "gradle" }
    ],
    longRunningCommandPatterns: ["mvn spring-boot:run", "gradle bootRun"],
    environmentChecks: ["JDK 17", "Maven or Gradle wrapper", "local repository/cache"],
    preferredTestCommands: ["./mvnw test", "mvn test", "./gradlew test", "gradle test"]
  },
  {
    language: "kotlin",
    displayName: "Kotlin",
    rootMarkers: ["build.gradle", "build.gradle.kts", "pom.xml"],
    importantFiles: ["build.gradle", "build.gradle.kts", "pom.xml", "settings.gradle", "settings.gradle.kts", ".mvn/wrapper/maven-wrapper.jar", "mvnw", "gradlew"],
    sourceGlobs: ["*.kt", "src/**/*.kt", "test/**/*.kt"],
    capabilities: ["build", "test", "run"],
    validationCommands: {
      build: ["gradle build", "mvn test"],
      test: ["gradle test", "mvn test"],
      run: ["gradle bootRun", "mvn spring-boot:run"]
    },
    wrappers: [
      { type: "gradle", command: "./gradlew", requiredFiles: ["build.gradle", "build.gradle.kts"], missingCommand: "gradle" },
      { type: "maven", command: "./mvnw", requiredFiles: ["pom.xml", ".mvn/wrapper/maven-wrapper.jar"], missingCommand: "mvn" }
    ],
    longRunningCommandPatterns: ["gradle bootRun", "mvn spring-boot:run"],
    environmentChecks: ["JDK 17", "Gradle or Maven wrapper"],
    preferredTestCommands: ["./gradlew test", "gradle test", "./mvnw test", "mvn test"]
  },
  {
    language: "swift",
    displayName: "Swift",
    rootMarkers: ["Package.swift"],
    importantFiles: ["Package.swift"],
    sourceGlobs: ["*.swift", "Sources/**/*.swift", "Tests/**/*.swift"],
    capabilities: ["build", "test", "run"],
    validationCommands: {
      build: ["swift build"],
      test: ["swift test"],
      run: ["swift run"]
    },
    wrappers: [],
    longRunningCommandPatterns: ["swift run"],
    environmentChecks: ["Swift toolchain", "package manifest"],
    preferredTestCommands: ["swift test"]
  },
  {
    language: "php",
    displayName: "PHP",
    rootMarkers: ["composer.json", "phpunit.xml", "phpunit.xml.dist"],
    importantFiles: ["composer.json", "phpunit.xml", "phpunit.xml.dist", "vendor/bin/phpunit"],
    sourceGlobs: ["*.php", "src/**/*.php", "tests/**/*.php"],
    capabilities: ["test", "run", "install"],
    validationCommands: {
      test: ["composer test", "vendor/bin/phpunit"],
      run: ["php -S localhost:8000 -t public"],
      install: ["composer install"]
    },
    wrappers: [{ type: "composer", command: "composer", requiredFiles: ["composer.json"] }],
    longRunningCommandPatterns: ["php -S", "php artisan serve"],
    environmentChecks: ["PHP runtime", "Composer"],
    preferredTestCommands: ["composer test", "vendor/bin/phpunit"]
  },
  {
    language: "ruby",
    displayName: "Ruby",
    rootMarkers: ["Gemfile", ".ruby-version"],
    importantFiles: ["Gemfile", "Gemfile.lock", ".ruby-version"],
    sourceGlobs: ["*.rb", "app/**/*.rb", "lib/**/*.rb", "test/**/*.rb", "spec/**/*.rb"],
    capabilities: ["test", "run", "install"],
    validationCommands: {
      test: ["bundle exec rspec", "ruby -Itest"],
      run: ["bundle exec ruby app.rb"],
      install: ["bundle install"]
    },
    wrappers: [{ type: "bundle", command: "bundle", requiredFiles: ["Gemfile"] }],
    longRunningCommandPatterns: ["rails server", "bundle exec puma"],
    environmentChecks: ["Ruby runtime", "Bundler"],
    preferredTestCommands: ["bundle exec rspec", "ruby -Itest"]
  },
  {
    language: "csharp",
    displayName: "C#",
    rootMarkers: ["*.sln", "*.csproj"],
    importantFiles: ["*.sln", "*.csproj"],
    sourceGlobs: ["*.cs", "src/**/*.cs", "tests/**/*.cs"],
    capabilities: ["build", "test", "run"],
    validationCommands: {
      build: ["dotnet build"],
      test: ["dotnet test"],
      run: ["dotnet run"]
    },
    wrappers: [{ type: "dotnet", command: "dotnet", requiredFiles: ["*.sln", "*.csproj"] }],
    longRunningCommandPatterns: ["dotnet run"],
    environmentChecks: [".NET SDK", "NuGet cache"],
    preferredTestCommands: ["dotnet test"]
  }
];

export const allRootMarkers = unique(adapters.flatMap((adapter) => adapter.rootMarkers));
export const allImportantFiles = unique(adapters.flatMap((adapter) => adapter.importantFiles));
export const allSourceGlobs = unique(adapters.flatMap((adapter) => adapter.sourceGlobs));

export function buildProjectProfile(fileTree: string[]): ProjectProfile {
  return buildProfile(fileTree);
}

export function validationCommandsForProfile(profile: ProjectProfile, stepType: ValidationStepType = "verify"): string[] {
  const commands = new Set<string>();
  for (const adapter of profile.adapters) {
    for (const command of adapter.validationCommands[stepType] ?? []) commands.add(command);
    if (stepType === "verify") {
      for (const command of adapter.preferredTestCommands ?? []) commands.add(command);
    }
  }
  return [...commands];
}

export function detectValidationCommandsFromProfile(profile: ProjectProfile, fileTree: string[], packageJson?: { scripts?: Record<string, string> }): string[] {
  const commands = new Set<string>();
  const packageManager = detectPackageManager(fileTree);

  for (const adapter of profile.adapters) {
    if (adapter.language === "typescript" || adapter.language === "javascript") {
      const scripts = packageJson?.scripts ?? {};
      if (scripts.build) commands.add(packageManagerCommand(packageManager, "run build"));
      if (scripts.test) commands.add(packageManagerCommand(packageManager, "test"));
      if (scripts.lint) commands.add(packageManagerCommand(packageManager, "run lint"));
      continue;
    }

    if (adapter.language === "python") {
      commands.add(fileTree.includes("uv.lock") || fileTree.includes("pyproject.toml") ? "uv run pytest" : "pytest");
      commands.add("python -m pytest");
      continue;
    }

    if (adapter.language === "go") {
      commands.add("go test ./...");
      continue;
    }

    if (adapter.language === "rust") {
      commands.add("cargo test");
      continue;
    }

    if (adapter.language === "java") {
      if (fileTree.includes("pom.xml")) commands.add(fileTree.includes(".mvn/wrapper/maven-wrapper.jar") ? "./mvnw test" : "mvn test");
      if (fileTree.includes("build.gradle") || fileTree.includes("build.gradle.kts")) commands.add(fileTree.includes("gradlew") ? "./gradlew test" : "gradle test");
      continue;
    }

    if (adapter.language === "kotlin") {
      if (fileTree.includes("build.gradle") || fileTree.includes("build.gradle.kts")) commands.add(fileTree.includes("gradlew") ? "./gradlew test" : "gradle test");
      if (fileTree.includes("pom.xml")) commands.add(fileTree.includes(".mvn/wrapper/maven-wrapper.jar") ? "./mvnw test" : "mvn test");
      continue;
    }

    if (adapter.language === "swift") {
      commands.add("swift test");
      continue;
    }

    if (adapter.language === "php") {
      commands.add("composer test");
      commands.add("vendor/bin/phpunit");
      continue;
    }

    if (adapter.language === "ruby") {
      commands.add("bundle exec rspec");
      commands.add("ruby -Itest");
      continue;
    }

    if (adapter.language === "csharp") {
      commands.add("dotnet test");
    }
  }

  return [...commands];
}

export function normalizeVerificationCommand(profile: ProjectProfile, command: string): string {
  if (command.includes("./mvnw")) {
    return profile.wrapperCommands.includes("./mvnw") && profile.importantFiles.includes(".mvn/wrapper/maven-wrapper.jar")
      ? command
      : command.replace(/(^|[\s;&|()])\.\/mvnw(?=\s|$)/g, "$1mvn");
  }
  if (command.includes("./gradlew")) {
    return profile.wrapperCommands.includes("./gradlew")
      ? command
      : command.replace(/(^|[\s;&|()])\.\/gradlew(?=\s|$)/g, "$1gradle");
  }
  return command;
}

export function isLongRunningCommandForProfile(command: string, profile?: ProjectProfile): boolean {
  const lower = command.toLowerCase();
  const genericPatterns = [
    /\buvicorn\b.*--reload/i,
    /\buvicorn\b.*--host/i,
    /\bfastapi\s+dev\b/i,
    /\bnpm\s+run\s+dev\b/i,
    /\bpnpm\s+dev\b/i,
    /\byarn\s+dev\b/i,
    /\bnext\s+dev\b/i,
    /\bvite\b/i
  ];
  if (genericPatterns.some((pattern) => pattern.test(command))) return true;
  return profile?.longRunningPatterns.some((pattern) => lower.includes(pattern.toLowerCase())) ?? false;
}

export function classifyEnvironmentFailures(results: Array<{ command: string; exitCode: number; stdout: string; stderr: string }>, profile?: ProjectProfile): EnvironmentIssue | undefined {
  const details: string[] = [];
  const suggestions = new Set<string>();
  const kinds = new Set<EnvironmentIssueKind>();

  for (const result of results.filter((item) => item.exitCode !== 0)) {
    const output = `${result.stderr}\n${result.stdout}`;
    const lower = output.toLowerCase();
    const command = result.command;

    if (/java version "1\.[0-8]\./i.test(output) || /openjdk version "1\.[0-8]\./i.test(output)) {
      kinds.add("version_mismatch");
      details.push(`Java 8 or older was detected while running "${command}".`);
      suggestions.add("Install JDK 17 or newer and set JAVA_HOME/PATH to that JDK before building.");
      continue;
    }

    if (isMissingWrapper(command, output, "gradlew")) {
      kinds.add("missing_wrapper");
      details.push(`Gradle wrapper is missing for "${command}".`);
      suggestions.add("Generate the Gradle wrapper or use a project that already includes it.");
      continue;
    }

    if (isMissingWrapper(command, output, "mvnw")) {
      kinds.add("missing_wrapper");
      details.push(`Maven wrapper is missing or broken for "${command}".`);
      suggestions.add("Regenerate or restore the Maven wrapper files.");
      continue;
    }

    if (command.includes("mvn") && lower.includes("invalid or corrupt jarfile")) {
      kinds.add("missing_wrapper");
      details.push(`Maven wrapper jar is invalid or corrupt while running "${command}".`);
      suggestions.add("Regenerate or restore `.mvn/wrapper/maven-wrapper.jar`.");
      continue;
    }

    if (lower.includes("could not transfer artifact") || lower.includes("could not resolve dependencies") || lower.includes("could not resolve plugin") || lower.includes("failed to transfer")) {
      kinds.add("dependency_download_failure");
      details.push(`Dependency or plugin resolution failed while running "${command}".`);
      suggestions.add("Check registry access, proxy settings, and local caches.");
      continue;
    }

    if (lower.includes(".m2/repository") || lower.includes("nuget") || lower.includes("cargo registry")) {
      if (lower.includes("permission denied") || lower.includes("failed to create parent directories") || lower.includes("no such file or directory") || lower.includes("eacces")) {
        kinds.add("permission_issue");
        details.push(`Toolchain cache write failed while running "${command}".`);
        suggestions.add("Fix cache permissions or point the toolchain at a writable local cache.");
        continue;
      }
    }

    const missingCommand = output.match(/(?:^|\n)\/bin\/sh:\s*(?:line \d+:\s*)?([^:\n]+): command not found/i) ?? output.match(/(?:^|\n)([^:\n]+): not found/i);
    if (result.exitCode === 127 || missingCommand) {
      kinds.add("missing_command");
      const tool = missingCommand?.[1]?.trim() || command.split(/\s+/)[0] || "required tool";
      details.push(`Missing command while running "${command}": ${tool}`);
      if (profile?.environmentChecks.length) {
        suggestions.add(`Install the required toolchain: ${profile.environmentChecks.join(", ")}.`);
      }
      suggestions.add(`Install or add "${tool}" to PATH, then rerun the command.`);
      continue;
    }

    if (/curl:\s*\(7\).*failed to connect/i.test(output) || lower.includes("couldn't connect to server") || lower.includes("connection refused")) {
      kinds.add("service_not_started");
      details.push(`Service was not reachable while running "${command}".`);
      suggestions.add("Start the service successfully before running endpoint checks.");
      continue;
    }

    if (lower.includes("enotfound") || lower.includes("could not resolve host") || lower.includes("network connectivity")) {
      kinds.add("network_unavailable");
      details.push(`Network access failed while running "${command}".`);
      suggestions.add("Check registry/network/proxy access, then rerun the command.");
      continue;
    }

    if (/permission denied|eacces/i.test(output)) {
      kinds.add("permission_issue");
      details.push(`Permission denied while running "${command}".`);
      suggestions.add("Fix file or cache permissions, then rerun the command.");
      continue;
    }

    if (/compile error|syntax error|error:|failed to compile/i.test(lower)) {
      kinds.add("compile_failed");
      details.push(`Compilation failed while running "${command}".`);
      suggestions.add("Fix the code or build configuration, then rerun the command.");
      continue;
    }

    if (/test(s)? failed|failing tests|failed tests/i.test(lower)) {
      kinds.add("test_failed");
      details.push(`Tests failed while running "${command}".`);
      suggestions.add("Fix the test or implementation failure, then rerun the command.");
      continue;
    }
  }

  if (details.length === 0) return undefined;
  return {
    kind: pickHighestPriorityKind(kinds),
    summary: "Validation stopped because the local development environment is missing required tools or services.",
    details,
    suggestions: [...suggestions]
  };
}

export function shouldAttemptEnvironmentFix(issue: EnvironmentIssue): boolean {
  return !["service_not_started", "dependency_download_failure", "network_unavailable", "compile_failed", "test_failed"].includes(issue.kind);
}

export function matchesProfileFile(filePath: string, profile: ProjectProfile): boolean {
  return profile.rootMarkers.some((marker) => matchesPattern(filePath, marker))
    || profile.importantFiles.some((marker) => matchesPattern(filePath, marker))
    || profile.adapters.some((adapter) => adapter.sourceGlobs.some((pattern) => matchesPattern(filePath, pattern)));
}

export async function detectValidationCommandsFromProfileOnDisk(root: string, profile: ProjectProfile): Promise<string[]> {
  const fileTree = await fg(["**/*"], { cwd: root, dot: true, onlyFiles: true, followSymbolicLinks: false });
  const packageJsonPath = path.join(root, "package.json");
  let packageJson: { scripts?: Record<string, string> } | undefined;
  if (await fs.pathExists(packageJsonPath)) {
    try {
      packageJson = await fs.readJson(packageJsonPath) as { scripts?: Record<string, string> };
    } catch {
      packageJson = undefined;
    }
  }
  return detectValidationCommandsFromProfile(profile, fileTree, packageJson);
}

export function buildProjectProfileFromContext(context: Pick<ProjectContext, "fileTree" | "importantFiles">): ProjectProfile {
  return buildProfile(context.fileTree);
}

function buildProfile(fileTree: string[]): ProjectProfile {
  const matched = adapters
    .map((adapter) => ({ adapter, score: scoreAdapter(adapter, fileTree) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.adapter);

  return {
    primaryLanguage: matched[0]?.language,
    languages: matched.map((adapter) => adapter.language),
    adapters: matched,
    rootMarkers: unique(matched.flatMap((adapter) => adapter.rootMarkers.filter((marker) => fileTree.some((file) => matchesPattern(file, marker))))),
    importantFiles: unique(matched.flatMap((adapter) => adapter.importantFiles.filter((marker) => fileTree.some((file) => matchesPattern(file, marker))))),
    recommendedValidationCommands: unique(matched.flatMap((adapter) => adapter.preferredTestCommands)),
    wrapperCommands: unique(matched.flatMap((adapter) => adapter.wrappers.map((wrapper) => wrapper.command))),
    longRunningPatterns: unique(matched.flatMap((adapter) => adapter.longRunningCommandPatterns)),
    environmentChecks: unique(matched.flatMap((adapter) => adapter.environmentChecks)),
    notes: matched.map((adapter) => `${adapter.displayName}: ${adapter.environmentChecks.join(", ")}`)
  };
}

export function hasProfileMarker(fileTree: string[], marker: string): boolean {
  return fileTree.some((file) => matchesPattern(file, marker));
}

function scoreAdapter(adapter: ToolchainAdapter, fileTree: string[]): number {
  let score = 0;
  for (const marker of adapter.rootMarkers) {
    if (fileTree.some((file) => matchesPattern(file, marker))) score += 3;
  }
  for (const pattern of adapter.sourceGlobs) {
    if (fileTree.some((file) => matchesPattern(file, pattern))) score += 1;
  }
  return score;
}

function detectPackageManager(fileTree: string[]): "pnpm" | "yarn" | "npm" {
  if (fileTree.includes("pnpm-lock.yaml")) return "pnpm";
  if (fileTree.includes("yarn.lock")) return "yarn";
  return "npm";
}

function packageManagerCommand(packageManager: "pnpm" | "yarn" | "npm", script: string): string {
  if (packageManager === "npm") return script === "test" ? "npm test" : `npm ${script}`;
  return `${packageManager} ${script}`;
}

function matchesPattern(filePath: string, pattern: string): boolean {
  const normalizedFile = filePath.split(path.sep).join("/");
  const normalizedPattern = pattern.split(path.sep).join("/");
  if (normalizedPattern === normalizedFile) return true;

  const hasGlob = /[*?{]/.test(normalizedPattern);
  if (!hasGlob) {
    return normalizedFile === normalizedPattern || path.posix.basename(normalizedFile) === normalizedPattern;
  }

  const regex = globToRegExp(normalizedPattern);
  if (regex.test(normalizedFile)) return true;
  return !normalizedPattern.includes("/") && regex.test(path.posix.basename(normalizedFile));
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (let i = 0; i < pattern.length;) {
    const char = pattern[i];

    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i += 2;
        if (pattern[i] === "/") {
          source += "(?:.*/)?";
          i++;
        } else {
          source += ".*";
        }
      } else {
        source += "[^/]*";
        i++;
      }
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      i++;
      continue;
    }

    if (char === "{") {
      const end = pattern.indexOf("}", i + 1);
      if (end !== -1) {
        const body = pattern.slice(i + 1, end);
        source += `(?:${body.split(",").map(escapeRegExp).join("|")})`;
        i = end + 1;
        continue;
      }
    }

    source += escapeRegExp(char);
    i++;
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegExp(value: string): string {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function isMissingWrapper(command: string, output: string, wrapper: "gradlew" | "mvnw"): boolean {
  const text = output.toLowerCase();
  return command.includes(wrapper) && (text.includes("no such file or directory") || text.includes("not found") || text.includes("invalid or corrupt jarfile"));
}

function pickHighestPriorityKind(kinds: Set<EnvironmentIssueKind>): EnvironmentIssueKind {
  const priority: EnvironmentIssueKind[] = [
    "missing_wrapper",
    "missing_command",
    "version_mismatch",
    "permission_issue",
    "dependency_download_failure",
    "network_unavailable",
    "service_not_started",
    "compile_failed",
    "test_failed",
    "unknown"
  ];
  for (const kind of priority) {
    if (kinds.has(kind)) return kind;
  }
  return "unknown";
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
