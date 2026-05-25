export type ProviderName =
  | "openai"
  | "deepseek"
  | "zhipu-cn"
  | "zhipu-global"
  | "kimi-cn"
  | "kimi-global"
  | "minimax-cn"
  | "minimax-global"
  | "qwen-cn"
  | "qwen-global"
  | "claude"
  | "gemini";

export type GlobalProviderConfig = {
  provider: ProviderName;
  apiKey?: string;
  model: string;
  baseUrl?: string;
  isDefault: boolean;
};

export type GlobalConfig = {
  providers: GlobalProviderConfig[];
};

export type ProjectConfig = {
  model?: string;
  autoApply: boolean;
  maxRepairAttempts: number;
  validationCommands: string[];
  ignore: string[];
};

export type RuntimeConfig = ProjectConfig & {
  provider: ProviderName;
  apiKey?: string;
  baseUrl?: string;
  model: string;
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
  profile?: ProjectProfile;
};

export type ProjectLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "kotlin"
  | "swift"
  | "php"
  | "ruby"
  | "csharp";

export type ToolchainCapability = "build" | "test" | "run" | "lint" | "install";

export type ToolchainWrapper = {
  type: "maven" | "gradle" | "npm" | "pnpm" | "yarn" | "bundle" | "dotnet" | "cargo" | "composer" | "swiftpm" | "python" | "go";
  command: string;
  requiredFiles: string[];
  missingCommand?: string;
};

export type ValidationStepType = "build" | "test" | "lint" | "run" | "install" | "verify" | "diagnostic" | "unknown";

export type ToolchainAdapter = {
  language: ProjectLanguage;
  displayName: string;
  rootMarkers: string[];
  importantFiles: string[];
  sourceGlobs: string[];
  capabilities: ToolchainCapability[];
  validationCommands: Partial<Record<ValidationStepType, string[]>>;
  wrappers: ToolchainWrapper[];
  longRunningCommandPatterns: string[];
  environmentChecks: string[];
  preferredTestCommands?: string[];
};

export type ProjectProfile = {
  primaryLanguage?: ProjectLanguage;
  languages: ProjectLanguage[];
  adapters: ToolchainAdapter[];
  rootMarkers: string[];
  importantFiles: string[];
  recommendedValidationCommands: string[];
  wrapperCommands: string[];
  longRunningPatterns: string[];
  environmentChecks: string[];
  notes: string[];
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

export type TaskStep = {
  id: string;
  title: string;
  description: string;
  expectedFiles: string[];
  verification: string;
  milestone?: boolean;
  dependsOn?: string[];
};

export type TaskPlan = {
  goal: string;
  steps: TaskStep[];
};

export type StepResult = {
  stepId: string;
  title: string;
  summary: string;
  filesChanged: string[];
  verificationResult: "passed" | "failed" | "skipped";
  semanticWarnings?: string[];
};

export type TaskFailure = {
  stepId: string;
  stepIndex: number;
  command?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  summary: string;
  details: string[];
  suggestions: string[];
  nextAction: string;
  occurredAt: string;
};

export type TaskState = {
  taskId: string;
  status: "planning" | "ready" | "running" | "paused" | "blocked" | "completed" | "failed";
  currentStepIndex: number;
  completedSteps: StepResult[];
  knownFailures: string[];
  blockedReason?: string;
  lastFailure?: TaskFailure;
  createdAt: string;
  updatedAt: string;
};
