export type ProviderName = "deepseek" | "openai";

export type GlobalConfig = {
  provider: ProviderName;
  apiKey?: string;
  model: string;
  baseUrl?: string;
};

export type ProjectConfig = {
  model: string;
  autoApply: boolean;
  maxRepairAttempts: number;
  validationCommands: string[];
  ignore: string[];
};

export type RuntimeConfig = ProjectConfig & {
  provider: ProviderName;
  apiKey?: string;
  baseUrl?: string;
};

export type ImportantFile = {
  path: string;
  content: string;
};

export type CodeSymbol = {
  path: string;
  name: string;
  kind: string;
  line: number;
  column: number;
  source?: "typescript" | "tree-sitter" | "regex";
  parser?: string;
  exported?: boolean;
  signature?: string;
};

export type CodeDiagnostic = {
  path: string;
  message: string;
  line: number;
  column: number;
  severity: "error" | "warning" | "suggestion" | "message";
  source?: "typescript" | "tree-sitter";
  parser?: string;
};

export type ProjectContext = {
  root: string;
  fileTree: string[];
  importantFiles: ImportantFile[];
  symbols?: CodeSymbol[];
  diagnostics?: CodeDiagnostic[];
  gitStatus?: string;
  gitDiff?: string;
  task?: string;
};

export type ValidationResult = {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

export type RunResult = {
  task: string;
  status: "success" | "failed" | "cancelled";
  startedAt: string;
  finishedAt: string;
  patchApplied: boolean;
  validationPassed: boolean;
  repairAttempts: number;
};
