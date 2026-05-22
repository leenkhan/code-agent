import type { ProjectContext } from "../types.js";

export function renderContext(context: ProjectContext): string {
  return JSON.stringify(
    {
      root: context.root,
      task: context.task,
      fileTree: context.fileTree,
      importantFiles: context.importantFiles,
      symbols: context.symbols,
      diagnostics: context.diagnostics,
      gitStatus: context.gitStatus,
      gitDiff: context.gitDiff
    },
    null,
    2
  );
}

export function extractJson(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}
