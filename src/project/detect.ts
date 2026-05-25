import { allImportantFiles, allRootMarkers, buildProjectProfile, detectValidationCommandsFromProfileOnDisk } from "./profile.js";
import { safeProjectGlob } from "./glob.js";

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
  return safeProjectGlob(importantFileGlobs, root);
}

export async function detectValidationCommands(root: string): Promise<string[]> {
  const files = await safeProjectGlob(["**/*"], root);
  const profile = buildProjectProfile(files);
  return detectValidationCommandsFromProfileOnDisk(root, profile);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
