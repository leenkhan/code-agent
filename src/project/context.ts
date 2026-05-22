import path from "node:path";
import fg from "fast-glob";
import ignore from "ignore";
import fs from "fs-extra";
import type { CodeDiagnostic, CodeSymbol, ProjectConfig, ProjectContext } from "../types.js";
import { canReadFile } from "../safety/file-policy.js";
import { gitDiff, gitStatus, isGitRepo } from "../tools/git.js";
import { importantFileGlobs } from "./detect.js";
import { readSmallTextFile } from "./files.js";

const maxFileBytes = 100 * 1024;
const maxFiles = 500;
const maxImportantFiles = 50;
const maxTotalImportantBytes = 250 * 1024;
const maxSymbolFiles = 80;
const maxSymbols = 400;
const maxDiagnostics = 100;
const sourceFileGlobs = [
  "*.{ts,tsx,js,jsx,mts,cts}",
  "src/**/*.{ts,tsx,js,jsx,mts,cts}",
  "lib/**/*.{ts,tsx,js,jsx,mts,cts}",
  "app/**/*.{ts,tsx,js,jsx,mts,cts}",
  "test/**/*.{ts,tsx,js,jsx,mts,cts}",
  "tests/**/*.{ts,tsx,js,jsx,mts,cts}",
  "*.{py,go,rs,java,kt,swift,php,rb,cs}",
  "**/*.{py,go,rs,java,kt,swift,php,rb,cs}"
];

type TypeScriptModule = typeof import("typescript");

type LoadedTextFile = {
  path: string;
  content: string;
};

async function buildIgnore(root: string, config: ProjectConfig): Promise<ReturnType<typeof ignore>> {
  const ig = ignore().add(config.ignore);
  const gitignorePath = path.join(root, ".gitignore");
  if (await fs.pathExists(gitignorePath)) {
    ig.add(await fs.readFile(gitignorePath, "utf8"));
  }
  return ig;
}

function isTypeScriptLike(filePath: string): boolean {
  return /\.(ts|tsx|js|jsx|mts|cts)$/i.test(filePath);
}

function lineColumnFromIndex(content: string, index: number): { line: number; column: number } {
  const prefix = content.slice(0, index);
  const lines = prefix.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function trimSignature(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 180);
}

async function loadTypeScript(): Promise<TypeScriptModule | undefined> {
  try {
    return await import("typescript");
  } catch {
    return undefined;
  }
}

function diagnosticSeverity(ts: TypeScriptModule, category: import("typescript").DiagnosticCategory): CodeDiagnostic["severity"] {
  if (category === ts.DiagnosticCategory.Error) return "error";
  if (category === ts.DiagnosticCategory.Warning) return "warning";
  if (category === ts.DiagnosticCategory.Suggestion) return "suggestion";
  return "message";
}

function hasExportModifier(ts: TypeScriptModule, node: import("typescript").Node): boolean {
  return Boolean(ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword));
}

function symbolKind(ts: TypeScriptModule, node: import("typescript").Node): string | undefined {
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isVariableStatement(node)) return "variable";
  if (ts.isMethodDeclaration(node)) return "method";
  return undefined;
}

function extractTypeScriptContext(ts: TypeScriptModule, file: LoadedTextFile): { symbols: CodeSymbol[]; diagnostics: CodeDiagnostic[] } {
  const scriptKind = file.path.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : file.path.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : /\.(js|mjs|cjs)$/i.test(file.path)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file.path, file.content, ts.ScriptTarget.Latest, true, scriptKind);
  const symbols: CodeSymbol[] = [];
  const parseDiagnostics = (source as { parseDiagnostics?: readonly import("typescript").Diagnostic[] }).parseDiagnostics ?? [];
  const diagnostics: CodeDiagnostic[] = parseDiagnostics.map((diagnostic) => {
    const position = typeof diagnostic.start === "number"
      ? source.getLineAndCharacterOfPosition(diagnostic.start)
      : { line: 0, character: 0 };
    return {
      path: file.path,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
      line: position.line + 1,
      column: position.character + 1,
      severity: diagnosticSeverity(ts, diagnostic.category)
    };
  });

  const addSymbol = (node: import("typescript").Node, name: string, kind: string, exported = false): void => {
    const position = source.getLineAndCharacterOfPosition(node.getStart(source));
    symbols.push({
      path: file.path,
      name,
      kind,
      line: position.line + 1,
      column: position.character + 1,
      exported,
      signature: trimSignature(node.getText(source).split("{", 1)[0] ?? node.getText(source))
    });
  };

  const visit = (node: import("typescript").Node): void => {
    const kind = symbolKind(ts, node);
    if (kind) {
      if (ts.isVariableStatement(node)) {
        for (const declaration of node.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) {
            addSymbol(declaration, declaration.name.text, kind, hasExportModifier(ts, node));
          }
        }
      } else if (
        (ts.isFunctionDeclaration(node) ||
          ts.isClassDeclaration(node) ||
          ts.isInterfaceDeclaration(node) ||
          ts.isTypeAliasDeclaration(node) ||
          ts.isEnumDeclaration(node) ||
          ts.isMethodDeclaration(node)) &&
        node.name &&
        ts.isIdentifier(node.name)
      ) {
        addSymbol(node, node.name.text, kind, hasExportModifier(ts, node));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return { symbols, diagnostics };
}

function extractRegexSymbols(file: LoadedTextFile): CodeSymbol[] {
  const patterns: Array<{ kind: string; regex: RegExp; nameIndex?: number }> = [
    { kind: "function", regex: /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm },
    { kind: "class", regex: /^\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/gm },
    { kind: "python-function", regex: /^\s*def\s+([A-Za-z_]\w*)\s*\(/gm },
    { kind: "python-class", regex: /^\s*class\s+([A-Za-z_]\w*)/gm },
    { kind: "go-function", regex: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gm },
    { kind: "rust-function", regex: /^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)\s*\(/gm },
    { kind: "java-class", regex: /^\s*(?:public\s+)?(?:final\s+)?class\s+([A-Za-z_]\w*)/gm },
    { kind: "java-method", regex: /^\s*(?:public|private|protected)\s+(?:static\s+)?[\w<>\[\], ?]+\s+([A-Za-z_]\w*)\s*\(/gm }
  ];
  const symbols: CodeSymbol[] = [];
  for (const pattern of patterns) {
    for (const match of file.content.matchAll(pattern.regex)) {
      const name = match[pattern.nameIndex ?? 1];
      if (!name) continue;
      const index = match.index ?? 0;
      const position = lineColumnFromIndex(file.content, index);
      symbols.push({
        path: file.path,
        name,
        kind: pattern.kind,
        line: position.line,
        column: position.column,
        signature: trimSignature(match[0])
      });
    }
  }
  return symbols;
}

async function collectSemanticContext(files: LoadedTextFile[]): Promise<{ symbols: CodeSymbol[]; diagnostics: CodeDiagnostic[] }> {
  const ts = await loadTypeScript();
  const symbols: CodeSymbol[] = [];
  const diagnostics: CodeDiagnostic[] = [];

  for (const file of files.slice(0, maxSymbolFiles)) {
    if (ts && isTypeScriptLike(file.path)) {
      const extracted = extractTypeScriptContext(ts, file);
      symbols.push(...extracted.symbols);
      diagnostics.push(...extracted.diagnostics);
    } else {
      symbols.push(...extractRegexSymbols(file));
    }
    if (symbols.length >= maxSymbols && diagnostics.length >= maxDiagnostics) break;
  }

  return {
    symbols: symbols.slice(0, maxSymbols),
    diagnostics: diagnostics.slice(0, maxDiagnostics)
  };
}

export async function collectProjectContext(root: string, config: ProjectConfig, task?: string): Promise<ProjectContext> {
  const ig = await buildIgnore(root, config);
  const allFiles = await fg(["**/*"], {
    cwd: root,
    dot: true,
    onlyFiles: true,
    absolute: false,
    followSymbolicLinks: false
  });
  const safeFiles = allFiles
    .filter((file) => canReadFile(file))
    .filter((file) => !ig.ignores(file))
    .slice(0, maxFiles);
  const importantCandidates = await fg(["README.md", ...importantFileGlobs, "vite.config.*", "next.config.*", ...sourceFileGlobs], {
    cwd: root,
    dot: true,
    onlyFiles: true,
    absolute: false
  });
  const importantFiles: LoadedTextFile[] = [];
  let totalBytes = 0;
  for (const relative of importantCandidates.filter((file) => safeFiles.includes(file)).slice(0, maxImportantFiles)) {
    const content = await readSmallTextFile(path.join(root, relative), maxFileBytes);
    if (!content) continue;
    totalBytes += Buffer.byteLength(content);
    if (totalBytes > maxTotalImportantBytes) break;
    importantFiles.push({ path: relative, content });
  }
  const semanticContext = await collectSemanticContext(importantFiles);
  const gitAvailable = await isGitRepo(root);
  return {
    root,
    fileTree: safeFiles,
    importantFiles,
    symbols: semanticContext.symbols,
    diagnostics: semanticContext.diagnostics,
    gitStatus: gitAvailable ? await gitStatus(root) : undefined,
    gitDiff: gitAvailable ? await gitDiff(root) : undefined,
    task
  };
}
