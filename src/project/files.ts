import fs from "fs-extra";

const binaryExtensions = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".mp4",
  ".mov",
  ".woff",
  ".woff2",
  ".ttf"
]);

export function looksBinary(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return [...binaryExtensions].some((extension) => lower.endsWith(extension));
}

export async function readSmallTextFile(filePath: string, maxBytes: number): Promise<string | undefined> {
  const stat = await fs.stat(filePath);
  if (stat.size > maxBytes || looksBinary(filePath)) {
    return undefined;
  }
  const buffer = await fs.readFile(filePath);
  if (buffer.includes(0)) {
    return undefined;
  }
  return buffer.toString("utf8");
}
