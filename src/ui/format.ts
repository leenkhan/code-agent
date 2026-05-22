import path from "node:path";

export function formatList(items: string[]): string {
  return items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : "- none";
}

export function relativePath(root: string, filePath: string): string {
  return path.relative(root, filePath) || ".";
}
