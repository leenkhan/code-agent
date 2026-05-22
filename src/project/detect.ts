import fg from "fast-glob";
import { allImportantFiles, allRootMarkers, buildProjectProfile, detectValidationCommandsFromProfileOnDisk } from "./profile.js";

export const importantFileGlobs = unique([
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "setup.py",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "go.mod",
  "Cargo.toml",
  "Cargo.lock",
  "go.sum",
  "Package.swift",
  "pubspec.yaml",
  "composer.json",
  "phpunit.xml",
  "phpunit.xml.dist",
  "Gemfile",
  ".ruby-version",
  "*.csproj",
  "*.sln",
  ...allRootMarkers,
  ...allImportantFiles
]);

export async function detectImportantFiles(root: string): Promise<string[]> {
  return fg(importantFileGlobs, { cwd: root, dot: true, onlyFiles: true, absolute: false });
}

export async function detectValidationCommands(root: string): Promise<string[]> {
  const files = await fg(["**/*"], { cwd: root, dot: true, onlyFiles: true, followSymbolicLinks: false });
  const profile = buildProjectProfile(files);
  return detectValidationCommandsFromProfileOnDisk(root, profile);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
