import path from "node:path";
import fs from "fs-extra";
import { createTwoFilesPatch } from "diff";
import { z } from "zod";
import type { LlmProvider } from "../llm/provider.js";
import type { ProjectContext } from "../types.js";
import { assertWritableFile } from "../safety/file-policy.js";
import { assertCommandAllowed } from "../safety/command-policy.js";
import { applyPatch, checkPatchApplies } from "../patch/apply.js";
import { isGitRepo } from "../tools/git.js";
import { renderContext, extractJson } from "../utils/llm.js";

const fileActionSchema = z.object({
  path: z.string().min(1),
  content: z.string()
});

const commandActionSchema = z.object({
  command: z.string().min(1),
  reason: z.string().default("")
});

const fileManifestSchema = z.object({
  path: z.string().min(1),
  purpose: z.string().default("")
});

const codeActionManifestSchema = z.object({
  summary: z.string(),
  files: z.array(fileManifestSchema).default([]),
  commands: z.array(commandActionSchema).default([])
});

const fileContentSchema = z.object({
  path: z.string().min(1),
  content: z.string()
});

const codeActionPlanSchema = z.object({
  summary: z.string(),
  files: z.array(fileActionSchema).default([]),
  commands: z.array(commandActionSchema).default([])
});

export type FileAction = z.infer<typeof fileActionSchema>;
export type CommandAction = z.infer<typeof commandActionSchema>;
export type CodeActionPlan = z.infer<typeof codeActionPlanSchema>;
type CodeActionManifest = z.infer<typeof codeActionManifestSchema>;
type ProgressUpdate = (message: string) => void;

export type FileActionApplyResult = {
  filesChanged: string[];
  patch: string;
  patchPath?: string;
  appliedWithPatch: boolean;
};

export type FileActionApplyOptions = {
  artifactDir?: string;
  patchName?: string;
};

export function parseCodeActionPlan(text: string): CodeActionPlan {
  let json: unknown;
  try {
    json = JSON.parse(extractJson(text)) as unknown;
  } catch (error) {
    throw new Error(`Code action response was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = codeActionPlanSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error("Code action response did not match the expected schema.");
  }
  return parsed.data;
}

function parseCodeActionManifest(text: string): CodeActionManifest {
  const parsed = codeActionManifestSchema.safeParse(JSON.parse(extractJson(text)) as unknown);
  if (!parsed.success) {
    throw new Error("Code action manifest response did not match the expected schema.");
  }
  return parsed.data;
}

function parseFileContent(text: string): FileAction {
  const parsed = fileContentSchema.safeParse(JSON.parse(extractJson(text)) as unknown);
  if (!parsed.success) {
    throw new Error("File content response did not match the expected schema.");
  }
  return parsed.data;
}

function shouldGenerateInChunks(task: string): boolean {
  const normalized = task.toLowerCase();
  const scaffoldKeywords = [
    "create a",
    "create an",
    "new project",
    "scaffold",
    "创建",
    "项目",
    "框架"
  ];
  const largeProjectKeywords = [
    "spring",
    "backend service",
    "后端",
    "服务框架",
    "kotlin",
    "java ",
    "认证",
    "登录",
    "注册",
    "auth service",
    "service framework",
    "sqlite",
    "sqllit",
    "database",
    "框架",
    "api"
  ];
  return scaffoldKeywords.some((keyword) => normalized.includes(keyword))
    && largeProjectKeywords.some((keyword) => normalized.includes(keyword));
}

export async function generateCodeActionPlan(input: {
  provider: LlmProvider;
  model: string;
  task: string;
  context: ProjectContext;
  onProgress?: ProgressUpdate;
}): Promise<CodeActionPlan> {
  if (shouldGenerateInChunks(input.task)) {
    return generateCodeActionPlanInChunks(input, "Large scaffold request; generating a manifest first to keep progress visible and avoid oversized JSON.");
  }

  try {
    input.onProgress?.("Generating file actions: drafting complete plan");
    const response = await input.provider.generateText({
      model: input.model,
      responseFormat: "json_object",
      system: `You generate concrete local file actions for a CLI code agent.
Return only strict JSON. Do not include markdown fences.
Do not return unified diff.
Do not include explanations outside JSON.
Create or replace files by returning complete file contents.
Keep the implementation simple, runnable, and scoped to the user task.
For larger apps, prefer a compact runnable scaffold with 5-8 source files instead of many tiny files.
Do not write sensitive files or generated dependency folders.
Do not include dangerous, destructive, deployment, publishing, sudo, or privileged commands.
For validation commands, prefer safe project-local commands.`,
      prompt: `Task:
${input.task}

Project context:
${renderContext(input.context)}

Return JSON with this exact shape:
{
  "summary": "short summary of the intended implementation",
  "files": [
    {
      "path": "relative/path/from/project/root",
      "content": "complete file content"
    }
  ],
  "commands": [
    {
      "command": "safe local command to optionally run",
      "reason": "why this command is useful"
    }
  ]
}`
    });
    input.onProgress?.("Generating file actions: parsing complete plan");
    return parseCodeActionPlan(response);
  } catch (error) {
    return generateCodeActionPlanInChunks(input, error instanceof Error ? error.message : String(error));
  }
}

async function generateCodeActionPlanInChunks(input: {
  provider: LlmProvider;
  model: string;
  task: string;
  context: ProjectContext;
  onProgress?: ProgressUpdate;
}, reason: string): Promise<CodeActionPlan> {
  input.onProgress?.("Generating file actions: planning file list");
  const manifestResponse = await input.provider.generateText({
    model: input.model,
    responseFormat: "json_object",
    system: `You generate a compact file manifest for a CLI code agent.
Return only strict JSON. Do not include file contents.
Keep the file list minimal and runnable.`,
    prompt: `The previous attempt to generate full file contents failed:
${reason}

Task:
${input.task}

Project context:
${renderContext(input.context)}

Return JSON:
{
  "summary": "short summary",
  "files": [{"path": "relative/path", "purpose": "what this file contains"}],
  "commands": [{"command": "safe local command", "reason": "why"}]
}`
  });
  input.onProgress?.("Generating file actions: parsing file list");
  const manifest = parseCodeActionManifest(manifestResponse);
  const files: FileAction[] = [];
  const failedFiles: string[] = [];

  const batchSize = 5;
  for (let batchStart = 0; batchStart < manifest.files.length; batchStart += batchSize) {
    const batch = manifest.files.slice(batchStart, batchStart + batchSize);
    const batchEnd = Math.min(batchStart + batchSize, manifest.files.length);
    input.onProgress?.(`Generating file actions: files ${batchStart + 1}-${batchEnd}/${manifest.files.length}`);

    let batchData: { files: FileAction[] };
    try {
      const batchResponse = await input.provider.generateText({
        model: input.model,
        responseFormat: "json_object",
        system: `You generate complete source files for a local code project.
Return only strict JSON. Do not include markdown fences.
All file contents must be complete and correct.
Maintain consistency across files (imports, references, types).`,
        prompt: `Overall task:
${input.task}

Project context:
${renderContext(input.context)}

Files to generate (batch ${Math.floor(batchStart / batchSize) + 1}):
${JSON.stringify(batch, null, 2)}

All files in this plan:
${JSON.stringify(manifest.files, null, 2)}

Return JSON:
{
  "files": [
    {"path": "relative/path", "content": "complete file content"}
  ]
}`
      });
      const parsed = JSON.parse(extractJson(batchResponse)) as { files?: FileAction[] };
      if (parsed.files?.length && parsed.files.every((file) => typeof file.path === "string" && typeof file.content === "string")) {
        batchData = { files: parsed.files };
      } else if (Array.isArray(parsed)) {
        batchData = { files: parsed as FileAction[] };
      } else {
        // fallback: try parsing as individual file
        const single = parseFileContent(batchResponse);
        files.push(single);
        continue;
      }
    } catch {
      // fallback: generate individually for this batch
      for (const file of batch) {
        try {
          const fileResponse = await input.provider.generateText({
            model: input.model,
            responseFormat: "json_object",
            system: `You generate one complete file. Return only strict JSON: {"path":"...","content":"..."}`,
            prompt: `Task: ${input.task}\nFile to generate:\n${JSON.stringify(file, null, 2)}`
          });
          files.push(parseFileContent(fileResponse));
        } catch (error) {
          failedFiles.push(`${file.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      continue;
    }

    for (const f of batchData.files) {
      files.push(f);
    }
  }
  if (failedFiles.length > 0) {
    throw new Error(`Failed to generate file contents for ${failedFiles.length}/${manifest.files.length} manifest file(s): ${failedFiles.join("; ")}`);
  }
  const missingFiles = manifest.files.filter((file) => !files.some((generated) => generated.path === file.path));
  if (missingFiles.length > 0) {
    throw new Error(`Model did not return content for manifest file(s): ${missingFiles.map((file) => file.path).join(", ")}`);
  }
  input.onProgress?.("Generating file actions: assembling plan");
  return {
    summary: manifest.summary,
    files,
    commands: manifest.commands
  };
}

export async function repairCodeActionJson(input: {
  provider: LlmProvider;
  model: string;
  task: string;
  response: string;
}): Promise<CodeActionPlan> {
  const repaired = await input.provider.generateText({
    model: input.model,
    responseFormat: "json_object",
    system: `Convert a failed CodeShit response into strict JSON.
Return only one JSON object. Do not include markdown fences.
The output must match:
{
  "summary": "short summary",
  "files": [{"path": "relative/path", "content": "complete file content"}],
  "commands": [{"command": "safe local command", "reason": "why"}]
}
If the original response only contains commands and no files, return those commands in commands and an empty files array.`,
    prompt: `Task:
${input.task}

Original non-JSON response:
${input.response}`
  });
  return parseCodeActionPlan(repaired);
}

function normalizeActionPath(relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Absolute write path blocked: ${relativePath}`);
  }
  const normalized = path.posix.normalize(relativePath.split(path.sep).join("/"));
  if (normalized.startsWith("../") || normalized === "..") {
    throw new Error(`Path traversal blocked: ${relativePath}`);
  }
  assertWritableFile(normalized);
  return normalized;
}

function resolveActionPath(root: string, relativePath: string): string {
  const normalized = normalizeActionPath(relativePath);
  const absolute = path.resolve(root, normalized);
  const rootWithSeparator = path.resolve(root) + path.sep;
  if (absolute !== path.resolve(root) && !absolute.startsWith(rootWithSeparator)) {
    throw new Error(`Write path escapes project root: ${relativePath}`);
  }
  return absolute;
}

export function validateCodeActionPlan(root: string, plan: CodeActionPlan, options: { requireFiles?: boolean } = {}): string[] {
  const errors: string[] = [];
  if (options.requireFiles && plan.files.length === 0) {
    errors.push("No file actions were returned for a code change task.");
  }
  if (plan.files.length === 0 && plan.commands.length === 0) {
    errors.push("No file or command actions were returned.");
  }
  for (const file of plan.files) {
    try {
      resolveActionPath(root, file.path);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  for (const command of plan.commands) {
    try {
      assertCommandAllowed(command.command);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return errors;
}

export async function createFileActionsPatch(root: string, files: FileAction[]): Promise<{ patch: string; filesChanged: string[] }> {
  const patches: string[] = [];
  const filesChanged: string[] = [];

  for (const file of files) {
    const normalized = normalizeActionPath(file.path);
    const absolute = resolveActionPath(root, normalized);
    const oldExists = await fs.pathExists(absolute);
    const oldContent = oldExists ? await fs.readFile(absolute, "utf8") : "";
    if (oldContent === file.content) continue;

    patches.push(createTwoFilesPatch(
      oldExists ? `a/${normalized}` : "/dev/null",
      `b/${normalized}`,
      oldContent,
      file.content,
      "",
      "",
      { context: 3 }
    ));
    filesChanged.push(normalized);
  }

  return { patch: patches.join("\n"), filesChanged };
}

function resolvePatchPath(options: FileActionApplyOptions | undefined): string | undefined {
  if (!options?.artifactDir) return undefined;
  const patchName = options.patchName ?? "patch.diff";
  if (path.basename(patchName) !== patchName) {
    throw new Error(`Patch artifact name must be a file name: ${patchName}`);
  }
  return path.join(options.artifactDir, patchName);
}

export async function applyFileActions(root: string, files: FileAction[], options: FileActionApplyOptions = {}): Promise<FileActionApplyResult> {
  const { patch, filesChanged } = await createFileActionsPatch(root, files);
  const patchPath = resolvePatchPath(options);
  const artifactPath = patchPath && patch.trim() ? patchPath : undefined;
  if (artifactPath) {
    await fs.ensureDir(path.dirname(artifactPath));
    await fs.writeFile(artifactPath, patch, "utf8");
  }

  if (filesChanged.length === 0) {
    return { filesChanged, patch, patchPath: artifactPath, appliedWithPatch: false };
  }

  if (artifactPath && await isGitRepo(root)) {
    const patchCheck = await checkPatchApplies(root, artifactPath);
    if (!patchCheck.ok) {
      throw new Error(`Generated patch cannot be applied by git:\n${patchCheck.error}`);
    }
    await applyPatch(root, artifactPath);
    return { filesChanged, patch, patchPath: artifactPath, appliedWithPatch: true };
  }

  for (const file of files) {
    const normalized = normalizeActionPath(file.path);
    if (!filesChanged.includes(normalized)) continue;
    const absolute = resolveActionPath(root, normalized);
    await fs.ensureDir(path.dirname(absolute));
    await fs.writeFile(absolute, file.content, "utf8");
  }

  return { filesChanged, patch, patchPath: artifactPath, appliedWithPatch: false };
}

export function formatCodeActionPlan(plan: CodeActionPlan): string {
  const fileLines = plan.files.length
    ? plan.files.map((file) => `- ${file.path} (${file.content.split("\n").length} lines)`).join("\n")
    : "- none";
  const commandLines = plan.commands.length
    ? plan.commands.map((command) => `- ${command.command}${command.reason ? `: ${command.reason}` : ""}`).join("\n")
    : "- none";
  return [
    plan.summary,
    "",
    "Files:",
    fileLines,
    "",
    "Suggested commands:",
    commandLines
  ].join("\n");
}

const envFixFilesSchema = z.object({
  files: z.array(z.object({
    path: z.string().min(1),
    content: z.string()
  })).default([]),
  commands: z.array(z.object({
    command: z.string().min(1),
    reason: z.string().default("")
  })).default([])
});

export async function generateEnvironmentFix(input: {
  provider: LlmProvider;
  model: string;
  issue: { summary: string; details: string[]; suggestions: string[] };
  context: ProjectContext;
  failedCommand: string;
}): Promise<{ files: FileAction[]; commands: Array<{ command: string; reason: string }> } | null> {
  try {
    const response = await input.provider.generateText({
      model: input.model,
      responseFormat: "json_object",
      system: `You fix missing development environment files for a local project.
The user's project is missing a tool, wrapper script, or configuration file needed to run a command.
Your job: generate the missing files so the command can succeed.
Return only strict JSON. Do not include markdown fences.

Examples of what to generate:
- Gradle wrapper files: gradlew, gradlew.bat, gradle/wrapper/gradle-wrapper.properties
- Maven wrapper: mvnw, mvnw.cmd, .mvn/wrapper/maven-wrapper.properties
- Missing config files: application.properties, .env.example
- Package manager files: package.json with required scripts

Only generate files that are safe and appropriate for a development environment.
Do NOT modify virtual environments, interpreter shims, dependency folders, or generated build output.
Do NOT generate binaries (.jar, .exe). For binary wrappers, generate shell scripts that download the binary.`,
      prompt: `The project failed to run this command:
$ ${input.failedCommand}

The failure was diagnosed as an environment issue:
${input.issue.summary}

Details:
${input.issue.details.map((d) => `- ${d}`).join("\n")}

Suggestions:
${input.issue.suggestions.map((s) => `- ${s}`).join("\n")}

Project context:
${renderContext(input.context)}

Generate the missing files and any safe setup commands needed. Return JSON:
{
  "files": [
    {"path": "relative/path", "content": "complete file content"}
  ],
  "commands": [
    {"command": "safe setup command (e.g. chmod +x gradlew)", "reason": "why this command is needed"}
  ]
}

If you cannot fix this automatically, return: {"files": [], "commands": []}`
    });

    const parsed = envFixFilesSchema.safeParse(JSON.parse(extractJson(response)) as unknown);
    if (!parsed.success || (parsed.data.files.length === 0 && parsed.data.commands.length === 0)) {
      return null;
    }
    const files = parsed.data.files.filter((file) => {
      try {
        normalizeActionPath(file.path);
        return true;
      } catch {
        return false;
      }
    });
    const commands = parsed.data.commands.filter((command) => {
      try {
        assertCommandAllowed(command.command);
        return true;
      } catch {
        return false;
      }
    });
    if (files.length === 0 && commands.length === 0) return null;
    return { files, commands };
  } catch {
    return null;
  }
}
