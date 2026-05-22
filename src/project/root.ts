import path from "node:path";
import fs from "fs-extra";
import { allRootMarkers } from "./profile.js";

const rootMarkers = [".git", ...allRootMarkers];

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
