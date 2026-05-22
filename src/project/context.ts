import path from "node:path";
import { createRequire } from "node:module";
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
type TreeSitterParserModule = typeof import("web-tree-sitter");

type TreeSitterNode = import("web-tree-sitter").SyntaxNode;
type TreeSitterLanguage = import("web-tree-sitter").Language;

type TreeSitterRuntime = {
  Parser: TreeSitterParserModule;
  languages: Map<string, TreeSitterLanguage>;
};

type LoadedTextFile = {
  path: string;
  content: string;
};

const require = createRequire(import.meta.url);
let treeSitterRuntimePromise: Promise<TreeSitterRuntime | undefined> | undefined;

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

function treeSitterLanguageName(filePath: string): string | undefined {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".py") return "python";
  if (extension === ".go") return "go";
  if (extension === ".rs") return "rust";
  if (extension === ".java") return "java";
  if (extension === ".kt") return "kotlin";
  if (extension === ".swift") return "swift";
  if (extension === ".php") return "php";
  if (extension === ".rb") return "ruby";
  if (extension === ".cs") return "c_sharp";
  return undefined;
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

async function loadTreeSitterRuntime(): Promise<TreeSitterRuntime | undefined> {
  treeSitterRuntimePromise ??= (async () => {
    try {
      const imported = await import("web-tree-sitter");
      const Parser = (imported.default ?? imported) as TreeSitterParserModule;
      await Parser.init();
      return { Parser, languages: new Map() };
    } catch {
      return undefined;
    }
  })();
  return treeSitterRuntimePromise;
}

async function loadTreeSitterLanguage(runtime: TreeSitterRuntime, languageName: string): Promise<TreeSitterLanguage | undefined> {
  const cached = runtime.languages.get(languageName);
  if (cached) return cached;

  try {
    const wasmPath = require.resolve(`tree-sitter-wasms/out/tree-sitter-${languageName}.wasm`);
    const language = await runtime.Parser.Language.load(wasmPath);
    runtime.languages.set(languageName, language);
    return language;
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
      severity: diagnosticSeverity(ts, diagnostic.category),
      source: "typescript",
      parser: "typescript"
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
      signature: trimSignature(node.getText(source).split("{", 1)[0] ?? node.getText(source)),
      source: "typescript",
      parser: "typescript"
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
        source: "regex",
        parser: "regex",
        signature: trimSignature(match[0])
      });
    }
  }
  return symbols;
}

function treeSitterSymbolKind(languageName: string, nodeType: string): string | undefined {
  const kindByLanguage: Record<string, Record<string, string>> = {
    python: {
      function_definition: "python-function",
      class_definition: "python-class"
    },
    go: {
      function_declaration: "go-function",
      method_declaration: "go-method",
      type_spec: "go-type"
    },
    rust: {
      function_item: "rust-function",
      struct_item: "rust-struct",
      enum_item: "rust-enum",
      trait_item: "rust-trait",
      impl_item: "rust-impl"
    },
    java: {
      class_declaration: "java-class",
      interface_declaration: "java-interface",
      enum_declaration: "java-enum",
      method_declaration: "java-method",
      constructor_declaration: "java-constructor"
    },
    kotlin: {
      function_declaration: "kotlin-function",
      class_declaration: "kotlin-class",
      object_declaration: "kotlin-object"
    },
    swift: {
      function_declaration: "swift-function",
      class_declaration: "swift-class",
      struct_declaration: "swift-struct",
      protocol_declaration: "swift-protocol",
      enum_declaration: "swift-enum"
    },
    php: {
      function_definition: "php-function",
      method_declaration: "php-method",
      class_declaration: "php-class",
      interface_declaration: "php-interface",
      trait_declaration: "php-trait"
    },
    ruby: {
      method: "ruby-method",
      singleton_method: "ruby-singleton-method",
      class: "ruby-class",
      module: "ruby-module"
    },
    c_sharp: {
      class_declaration: "csharp-class",
      interface_declaration: "csharp-interface",
      struct_declaration: "csharp-struct",
      enum_declaration: "csharp-enum",
      method_declaration: "csharp-method"
    }
  };
  return kindByLanguage[languageName]?.[nodeType];
}

function treeSitterNodeIsMissing(node: TreeSitterNode): boolean {
  const isMissing = node.isMissing as unknown;
  return typeof isMissing === "function" ? isMissing.call(node) : Boolean(isMissing);
}

function treeSitterNameForNode(node: TreeSitterNode): string | undefined {
  const named = node.childForFieldName("name")?.text ?? node.childForFieldName("property")?.text;
  if (named) return named;
  const identifier = node.namedChildren.find((child) => /^(identifier|type_identifier|constant|name)$/.test(child.type));
  return identifier?.text;
}

function extractTreeSitterContext(runtime: TreeSitterRuntime, language: TreeSitterLanguage, languageName: string, file: LoadedTextFile): { symbols: CodeSymbol[]; diagnostics: CodeDiagnostic[] } {
  const parser = new runtime.Parser();
  const timeoutSetter = parser.setTimeoutMicros as unknown;
  if (typeof timeoutSetter === "function") {
    timeoutSetter.call(parser, 100_000);
  }
  const symbols: CodeSymbol[] = [];
  const diagnostics: CodeDiagnostic[] = [];
  const parserName = `tree-sitter-${languageName.replace("_", "-")}`;
  const seenSymbols = new Set<string>();
  let errorCount = 0;

  const visit = (node: TreeSitterNode): void => {
    const kind = treeSitterSymbolKind(languageName, node.type);
    if (kind) {
      const name = treeSitterNameForNode(node);
      if (name) {
        const key = `${node.startIndex}:${kind}:${name}`;
        if (!seenSymbols.has(key)) {
          seenSymbols.add(key);
          symbols.push({
            path: file.path,
            name,
            kind,
            line: node.startPosition.row + 1,
            column: node.startPosition.column + 1,
            source: "tree-sitter",
            parser: parserName,
            signature: trimSignature(node.text.split("\n", 1)[0] ?? node.text)
          });
        }
      }
    }

    if (errorCount < 20 && (node.type === "ERROR" || treeSitterNodeIsMissing(node))) {
      errorCount += 1;
      diagnostics.push({
        path: file.path,
        message: node.type === "ERROR" ? `Tree-sitter parse error near ${trimSignature(node.text)}` : `Tree-sitter missing syntax node: ${node.type}`,
        line: node.startPosition.row + 1,
        column: node.startPosition.column + 1,
        severity: "error",
        source: "tree-sitter",
        parser: parserName
      });
    }

    for (const child of node.children) {
      visit(child);
    }
  };

  try {
    parser.setLanguage(language);
    const tree = parser.parse(file.content);
    try {
      visit(tree.rootNode);
      return { symbols, diagnostics };
    } finally {
      tree.delete();
    }
  } finally {
    parser.delete();
  }
}

async function collectSemanticContext(files: LoadedTextFile[]): Promise<{ symbols: CodeSymbol[]; diagnostics: CodeDiagnostic[] }> {
  const ts = await loadTypeScript();
  const treeSitter = await loadTreeSitterRuntime();
  const symbols: CodeSymbol[] = [];
  const diagnostics: CodeDiagnostic[] = [];

  for (const file of files.slice(0, maxSymbolFiles)) {
    if (ts && isTypeScriptLike(file.path)) {
      const extracted = extractTypeScriptContext(ts, file);
      symbols.push(...extracted.symbols);
      diagnostics.push(...extracted.diagnostics);
    } else if (treeSitter) {
      const languageName = treeSitterLanguageName(file.path);
      const language = languageName ? await loadTreeSitterLanguage(treeSitter, languageName) : undefined;
      if (language && languageName) {
        try {
          const extracted = extractTreeSitterContext(treeSitter, language, languageName, file);
          symbols.push(...extracted.symbols);
          diagnostics.push(...extracted.diagnostics);
        } catch {
          symbols.push(...extractRegexSymbols(file));
        }
      } else {
        symbols.push(...extractRegexSymbols(file));
      }
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
