import path from "node:path";

export const blockedReadPatterns = [
  ".env",
  ".env.*",
  "*.pem",
  "*.key",
  "id_rsa",
  "id_ed25519",
  ".ssh/**",
  ".aws/**",
  ".gcp/**",
  ".azure/**"
];

export const blockedWritePatterns = [
  ".git/**",
  "node_modules/**",
  "venv/**",
  ".venv/**",
  "dist/**",
  "build/**",
  ".next/**",
  ".nuxt/**",
  "coverage/**",
  ".env",
  ".env.*"
];

const blockedWriteDirectoryNames = new Set([
  ".git",
  "node_modules",
  "venv",
  ".venv",
  "dist",
  "build",
  ".next",
  ".nuxt",
  "coverage"
]);

function normalizePath(filePath: string): string {
  return filePath.split(path.sep).join("/").replace(/^\.\//, "");
}

function matchesPattern(filePath: string, pattern: string): boolean {
  if (pattern.endsWith("/**")) {
    const base = pattern.slice(0, -3);
    return filePath === base || filePath.startsWith(`${base}/`);
  }
  if (pattern.startsWith("*.")) {
    return path.posix.basename(filePath).endsWith(pattern.slice(1));
  }
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1);
    return filePath.startsWith(prefix);
  }
  return filePath === pattern || path.posix.basename(filePath) === pattern;
}

function matchesAny(filePath: string, patterns: string[]): boolean {
  const normalized = normalizePath(filePath);
  return patterns.some((pattern) => matchesPattern(normalized, pattern));
}

function containsBlockedWriteDirectory(filePath: string): boolean {
  return normalizePath(filePath).split("/").some((segment) => blockedWriteDirectoryNames.has(segment));
}

export function canReadFile(filePath: string): boolean {
  return !matchesAny(filePath, blockedReadPatterns);
}

export function canWriteFile(filePath: string): boolean {
  return !containsBlockedWriteDirectory(filePath) && !matchesAny(filePath, blockedWritePatterns) && canReadFile(filePath);
}

export function assertReadableFile(filePath: string): void {
  if (!canReadFile(filePath)) {
    throw new Error(`Sensitive file access blocked: ${filePath}`);
  }
}

export function assertWritableFile(filePath: string): void {
  if (!canWriteFile(filePath)) {
    throw new Error(`Forbidden write path blocked: ${filePath}`);
  }
}
