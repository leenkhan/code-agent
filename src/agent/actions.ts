import path from "node:path";
import fs from "fs-extra";
import { z } from "zod";
import type { LlmProvider } from "../llm/provider.js";
import type { ProjectContext } from "../types.js";
import { assertWritableFile } from "../safety/file-policy.js";
import { assertCommandAllowed } from "../safety/command-policy.js";
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

export async function generateCodeActionPlan(input: {
  provider: LlmProvider;
  model: string;
  task: string;
  context: ProjectContext;
}): Promise<CodeActionPlan> {
  try {
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
}, reason: string): Promise<CodeActionPlan> {
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
  const manifest = parseCodeActionManifest(manifestResponse);
  const files: FileAction[] = [];
  for (const file of manifest.files) {
    const fileResponse = await input.provider.generateText({
      model: input.model,
      responseFormat: "json_object",
      system: `You generate one complete file for a local code project.
Return only strict JSON. Do not include markdown fences.
The content must be complete for this single file.`,
      prompt: `Overall task:
${input.task}

Project context:
${renderContext(input.context)}

File to generate:
${JSON.stringify(file, null, 2)}

Other files in this plan:
${JSON.stringify(manifest.files, null, 2)}

Return JSON:
{
  "path": "${file.path}",
  "content": "complete file content"
}`
    });
    files.push(parseFileContent(fileResponse));
  }
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
    system: `Convert a failed code-agent response into strict JSON.
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

function resolveActionPath(root: string, relativePath: string): string {
  if (path.isAbsolute(relativePath)) {
    throw new Error(`Absolute write path blocked: ${relativePath}`);
  }
  const normalized = path.posix.normalize(relativePath.split(path.sep).join("/"));
  if (normalized.startsWith("../") || normalized === "..") {
    throw new Error(`Path traversal blocked: ${relativePath}`);
  }
  assertWritableFile(normalized);
  const absolute = path.resolve(root, normalized);
  const rootWithSeparator = path.resolve(root) + path.sep;
  if (absolute !== path.resolve(root) && !absolute.startsWith(rootWithSeparator)) {
    throw new Error(`Write path escapes project root: ${relativePath}`);
  }
  return absolute;
}

export function validateCodeActionPlan(root: string, plan: CodeActionPlan): string[] {
  const errors: string[] = [];
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

export async function applyFileActions(root: string, files: FileAction[]): Promise<void> {
  for (const file of files) {
    const absolute = resolveActionPath(root, file.path);
    await fs.ensureDir(path.dirname(absolute));
    await fs.writeFile(absolute, file.content, "utf8");
  }
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
