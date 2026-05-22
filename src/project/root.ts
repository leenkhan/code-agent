import path from "node:path";
import fs from "fs-extra";

const rootMarkers = [".git", "package.json", "pyproject.toml", "go.mod", "Cargo.toml", "pom.xml", "build.gradle", "pubspec.yaml"];

export async function findProjectRoot(startDir = process.cwd()): Promise<string> {
  let current = path.resolve(startDir);
  while (true) {
    for (const marker of rootMarkers) {
      if (await fs.pathExists(path.join(current, marker))) {
        return current;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(startDir);
    }
    current = parent;
  }
}
