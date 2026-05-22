import path from "node:path";
import fg from "fast-glob";
import fs from "fs-extra";

export const importantFileGlobs = [
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "pom.xml",
  "build.gradle",
  "go.mod",
  "Cargo.toml",
  "pubspec.yaml",
  "composer.json",
  "*.csproj",
  "*.sln"
];

export async function detectImportantFiles(root: string): Promise<string[]> {
  return fg(importantFileGlobs, { cwd: root, dot: true, onlyFiles: true, absolute: false });
}

export async function detectValidationCommands(root: string): Promise<string[]> {
  const packageJsonPath = path.join(root, "package.json");
  if (!(await fs.pathExists(packageJsonPath))) {
    return [];
  }
  const pkg = (await fs.readJson(packageJsonPath)) as { scripts?: Record<string, string> };
  const scripts = pkg.scripts ?? {};
  const commands: string[] = [];
  if (scripts.test) commands.push("npm test");
  if (scripts.build) commands.push("npm run build");
  if (scripts.lint) commands.push("npm run lint");
  return commands;
}
