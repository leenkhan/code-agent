import path from "node:path";
import fg from "fast-glob";
import fs from "fs-extra";
import ignore from "ignore";
import type { ProjectConfig } from "../types.js";
import { blockedReadPatterns, canReadFile } from "../safety/file-policy.js";
import { defaultProjectConfig } from "../state/project-config.js";

const builtInIgnoredDirectories = [
  ".Trash",
  "Library",
  "Movies",
  "Music",
  "Pictures",
  "Desktop",
  "Documents",
  "Downloads",
  ".ssh",
  ".aws",
  ".gcp",
  ".azure",
  ".codeshit",
  ".code-agent"
];

export const defaultSafeGlobIgnorePatterns = unique([
  ...expandDirectoryPatterns(builtInIgnoredDirectories),
  ...blockedReadPatterns
]);

type SafeProjectGlobOptions = {
  config?: Pick<ProjectConfig, "ignore">;
};

export async function safeProjectGlob(patterns: string[], root: string, options: SafeProjectGlobOptions = {}): Promise<string[]> {
  const ignorePatterns = await buildSafeGlobIgnorePatterns(root, options.config);
  const filter = ignore().add([
    ...defaultProjectConfig.ignore,
    ...(options.config?.ignore ?? []),
    ...(await readGitignorePatterns(root)),
    ...defaultSafeGlobIgnorePatterns
  ]);
  const files = await fg(patterns, {
    cwd: root,
    dot: true,
    onlyFiles: true,
    absolute: false,
    followSymbolicLinks: false,
    suppressErrors: true,
    ignore: ignorePatterns
  });
  return unique(files.map(normalizeRelativePath))
    .filter((file) => canReadFile(file))
    .filter((file) => !filter.ignores(file));
}

export async function buildSafeGlobIgnorePatterns(root: string, config?: Pick<ProjectConfig, "ignore">): Promise<string[]> {
  return unique([
    ...defaultSafeGlobIgnorePatterns,
    ...expandTraversalPatterns([...defaultProjectConfig.ignore, ...(config?.ignore ?? [])]),
    ...expandTraversalPatterns(await readGitignorePatterns(root))
  ]);
}

async function readGitignorePatterns(root: string): Promise<string[]> {
  const gitignorePath = path.join(root, ".gitignore");
  try {
    const content = await fs.readFile(gitignorePath, "utf8");
    return content.split(/\r?\n/);
  } catch (error) {
    if (isSkippableFsError(error)) return [];
    return [];
  }
}

function expandTraversalPatterns(patterns: string[]): string[] {
  return patterns.flatMap((pattern) => {
    const normalized = normalizeIgnorePattern(pattern);
    if (!normalized || normalized.startsWith("#") || normalized.startsWith("!")) return [];
    return expandPotentialDirectoryPattern(normalized);
  });
}

function expandPotentialDirectoryPattern(pattern: string): string[] {
  const withoutTrailingSlash = pattern.replace(/\/+$/, "");
  if (!withoutTrailingSlash) return [];
  if (withoutTrailingSlash.startsWith("#") || withoutTrailingSlash.startsWith("!")) return [];
  if (hasGlobSyntax(withoutTrailingSlash) || path.posix.extname(withoutTrailingSlash)) {
    return [withoutTrailingSlash];
  }
  const nested = `**/${withoutTrailingSlash}`;
  return [withoutTrailingSlash, `${withoutTrailingSlash}/**`, nested, `${nested}/**`];
}

function expandDirectoryPatterns(names: string[]): string[] {
  return names.flatMap((name) => {
    const normalized = normalizeIgnorePattern(name).replace(/\/+$/, "");
    if (!normalized) return [];
    const nested = `**/${normalized}`;
    return [normalized, `${normalized}/**`, nested, `${nested}/**`];
  });
}

function normalizeIgnorePattern(pattern: string): string {
  return pattern.trim().split(path.sep).join("/").replace(/^\.\//, "").replace(/^\//, "");
}

function normalizeRelativePath(filePath: string): string {
  return filePath.split(path.sep).join("/").replace(/^\.\//, "");
}

function hasGlobSyntax(pattern: string): boolean {
  return /[*?[\]{}()!+@]/.test(pattern);
}

function isSkippableFsError(error: unknown): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && ["EPERM", "EACCES", "ENOENT"].includes(String((error as NodeJS.ErrnoException).code));
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}
