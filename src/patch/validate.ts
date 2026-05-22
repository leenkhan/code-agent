import { assertWritableFile } from "../safety/file-policy.js";

export type PatchValidation = {
  ok: boolean;
  errors: string[];
  files: string[];
};

function extractFiles(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const parts = line.split(" ");
      const bPath = parts[3]?.replace(/^b\//, "");
      if (bPath && bPath !== "/dev/null") files.add(bPath);
    }
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      const raw = line.slice(4).trim();
      if (raw !== "/dev/null") files.add(raw.replace(/^[ab]\//, ""));
    }
  }
  return [...files];
}

export function validatePatch(diff: string): PatchValidation {
  const errors: string[] = [];
  if (!(diff.includes("diff --git") || (diff.includes("--- ") && diff.includes("+++ ")))) {
    errors.push("Patch must contain diff headers.");
  }
  if (!diff.includes("@@")) {
    errors.push("Patch must contain at least one hunk marker.");
  }
  const files = extractFiles(diff);
  if (files.length === 0) {
    errors.push("Patch does not identify any changed files.");
  }
  for (const file of files) {
    try {
      assertWritableFile(file);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return { ok: errors.length === 0, errors, files };
}
