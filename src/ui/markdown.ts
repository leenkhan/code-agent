const ANSI_RESET = "\u001b[0m";
const ANSI_BOLD = "\u001b[1m";
const ANSI_DIM = "\u001b[2m";
const ANSI_CYAN = "\u001b[36m";
const ANSI_CODE_BG = "\u001b[48;5;236m";

type Table = {
  headers: string[];
  rows: string[][];
};

export function renderMarkdown(message: string): string {
  const lines = message.replace(/\r\n/g, "\n").split("\n");
  const output: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (line.trim().startsWith("```")) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? "").trim().startsWith("```")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      output.push(...renderCodeBlock(codeLines));
      continue;
    }

    const table = readTable(lines, index);
    if (table) {
      output.push(...renderTable(table.table));
      index = table.endIndex;
      continue;
    }

    output.push(renderMarkdownLine(line));
  }

  return output.join("\n");
}

export function stripAnsiCodes(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

export function displayWidth(value: string): number {
  let width = 0;
  for (const char of stripAnsiCodes(value)) {
    width += codePointWidth(char.codePointAt(0) ?? 0);
  }
  return width;
}

export function wrapDisplayLine(value: string, columns: number): string[] {
  const limit = Math.max(columns, 1);
  const chunks: string[] = [];
  let current = "";
  let currentWidth = 0;

  for (const token of readDisplayTokens(value)) {
    if (token.width === 0) {
      current += token.value;
      continue;
    }

    if (currentWidth > 0 && currentWidth + token.width > limit) {
      chunks.push(current);
      current = "";
      currentWidth = 0;
    }

    current += token.value;
    currentWidth += token.width;
  }

  chunks.push(current);
  return chunks.length > 0 ? chunks : [""];
}

export function fitDisplayLine(value: string, columns: number): string {
  const limit = Math.max(columns, 0);
  if (limit === 0) return "";

  let output = "";
  let width = 0;
  let truncated = false;
  let sawAnsi = false;

  for (const token of readDisplayTokens(value)) {
    if (token.width === 0) {
      output += token.value;
      sawAnsi ||= token.kind === "ansi";
      continue;
    }
    if (width + token.width > limit) {
      truncated = true;
      break;
    }
    output += token.value;
    width += token.width;
  }

  if (truncated && sawAnsi && !output.endsWith(ANSI_RESET)) {
    output += ANSI_RESET;
  }
  if (width < limit) output += " ".repeat(limit - width);
  return output;
}

function renderMarkdownLine(line: string): string {
  const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
  if (heading) {
    return `${ANSI_BOLD}${ANSI_CYAN}${renderInline(heading[2] ?? "")}${ANSI_RESET}`;
  }

  const quote = line.match(/^\s{0,3}>\s?(.*)$/);
  if (quote) {
    return `${ANSI_DIM}|${ANSI_RESET} ${renderInline(quote[1] ?? "")}`;
  }

  const unordered = line.match(/^(\s*)[-*+]\s+(.+)$/);
  if (unordered) {
    return `${normalizeIndent(unordered[1] ?? "")}- ${renderInline(unordered[2] ?? "")}`;
  }

  const ordered = line.match(/^(\s*)(\d+[.)])\s+(.+)$/);
  if (ordered) {
    return `${normalizeIndent(ordered[1] ?? "")}${ordered[2]} ${renderInline(ordered[3] ?? "")}`;
  }

  return renderInline(line);
}

function renderInline(value: string): string {
  const placeholders: string[] = [];
  let rendered = value.replace(/`([^`\n]+)`/g, (_match, code: string) => {
    const replacement = `${ANSI_CODE_BG} ${code} ${ANSI_RESET}`;
    placeholders.push(replacement);
    return `\u0000${placeholders.length - 1}\u0000`;
  });

  rendered = rendered.replace(/\*\*([^*\n]+)\*\*/g, `${ANSI_BOLD}$1${ANSI_RESET}`);
  rendered = rendered.replace(/\u0000(\d+)\u0000/g, (_match, rawIndex: string) => placeholders[Number(rawIndex)] ?? "");
  return rendered;
}

function renderCodeBlock(lines: string[]): string[] {
  const width = Math.max(3, ...lines.map((line) => displayWidth(line)));
  const border = `${ANSI_DIM}${"─".repeat(width + 2)}${ANSI_RESET}`;
  return [
    border,
    ...lines.map((line) => `  ${line}`),
    border
  ];
}

function normalizeIndent(indent: string): string {
  const levels = Math.floor(indent.replace(/\t/g, "  ").length / 2);
  return "  ".repeat(levels);
}

function readTable(lines: string[], startIndex: number): { table: Table; endIndex: number } | undefined {
  const headerLine = lines[startIndex] ?? "";
  const separatorLine = lines[startIndex + 1] ?? "";
  if (!isTableRow(headerLine) || !isSeparatorRow(separatorLine)) return undefined;

  const headers = parseTableRow(headerLine);
  const separatorCells = parseTableRow(separatorLine);
  if (headers.length < 2 || separatorCells.length !== headers.length) return undefined;

  const rows: string[][] = [];
  let index = startIndex + 2;
  while (index < lines.length && isTableRow(lines[index] ?? "")) {
    const row = parseTableRow(lines[index] ?? "");
    rows.push(normalizeTableRow(row, headers.length));
    index += 1;
  }

  return {
    table: { headers, rows },
    endIndex: index - 1
  };
}

function isTableRow(line: string): boolean {
  return line.includes("|") && parseTableRow(line).length >= 2;
}

function isSeparatorRow(line: string): boolean {
  const cells = parseTableRow(line);
  return cells.length >= 2 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim();
  const withoutEdges = trimmed.replace(/^\|/, "").replace(/\|$/, "");
  return withoutEdges.split("|").map((cell) => cell.trim());
}

function normalizeTableRow(row: string[], columns: number): string[] {
  if (row.length === columns) return row;
  if (row.length > columns) return row.slice(0, columns);
  return [...row, ...Array.from({ length: columns - row.length }, () => "")];
}

function renderTable(table: Table): string[] {
  const rows = [table.headers, ...table.rows];
  const widths = table.headers.map((_header, columnIndex) =>
    Math.max(...rows.map((row) => displayWidth(renderInline(row[columnIndex] ?? ""))))
  );

  return [
    renderTableBorder("top", widths),
    renderTableRow(table.headers, widths),
    renderTableBorder("middle", widths),
    ...table.rows.map((row) => renderTableRow(row, widths)),
    renderTableBorder("bottom", widths)
  ];
}

function renderTableRow(row: string[], widths: number[]): string {
  const cells = widths.map((width, index) => {
    const content = renderInline(row[index] ?? "");
    return ` ${content}${" ".repeat(width - displayWidth(content))} `;
  });
  return `│${cells.join("│")}│`;
}

function renderTableBorder(kind: "top" | "middle" | "bottom", widths: number[]): string {
  const chars = {
    top: ["┌", "┬", "┐"],
    middle: ["├", "┼", "┤"],
    bottom: ["└", "┴", "┘"]
  }[kind];
  return `${chars[0]}${widths.map((width) => "─".repeat(width + 2)).join(chars[1])}${chars[2]}`;
}

type DisplayToken = {
  value: string;
  width: number;
  kind: "ansi" | "text";
};

function readDisplayTokens(value: string): DisplayToken[] {
  const tokens: DisplayToken[] = [];
  for (let index = 0; index < value.length;) {
    if (value.charCodeAt(index) === 0x1b) {
      const match = value.slice(index).match(/^\u001b\[[0-9;?]*[ -/]*[@-~]/);
      if (match) {
        tokens.push({ value: match[0], width: 0, kind: "ansi" });
        index += match[0].length;
        continue;
      }
    }

    const codePoint = value.codePointAt(index) ?? 0;
    const char = String.fromCodePoint(codePoint);
    tokens.push({ value: char, width: codePointWidth(codePoint), kind: "text" });
    index += char.length;
  }
  return tokens;
}

function codePointWidth(codePoint: number): number {
  if (codePoint === 0) return 0;
  if (codePoint < 32 || (codePoint >= 0x7f && codePoint < 0xa0)) return 0;
  if (isCombiningMark(codePoint) || isVariationSelector(codePoint) || codePoint === 0x200d) return 0;
  if (isWideCodePoint(codePoint)) return 2;
  return 1;
}

function isCombiningMark(codePoint: number): boolean {
  return (
    (codePoint >= 0x0300 && codePoint <= 0x036f)
    || (codePoint >= 0x0483 && codePoint <= 0x0489)
    || (codePoint >= 0x0591 && codePoint <= 0x05bd)
    || codePoint === 0x05bf
    || (codePoint >= 0x05c1 && codePoint <= 0x05c2)
    || (codePoint >= 0x05c4 && codePoint <= 0x05c5)
    || codePoint === 0x05c7
    || (codePoint >= 0x0610 && codePoint <= 0x061a)
    || (codePoint >= 0x064b && codePoint <= 0x065f)
    || codePoint === 0x0670
    || (codePoint >= 0x06d6 && codePoint <= 0x06dc)
    || (codePoint >= 0x06df && codePoint <= 0x06e4)
    || (codePoint >= 0x06e7 && codePoint <= 0x06e8)
    || (codePoint >= 0x06ea && codePoint <= 0x06ed)
    || (codePoint >= 0x0711 && codePoint <= 0x074a)
    || (codePoint >= 0x07a6 && codePoint <= 0x07b0)
    || (codePoint >= 0x07eb && codePoint <= 0x07f3)
    || (codePoint >= 0x0816 && codePoint <= 0x082d)
    || (codePoint >= 0x0859 && codePoint <= 0x085b)
    || (codePoint >= 0x08d3 && codePoint <= 0x08ff)
    || (codePoint >= 0x0900 && codePoint <= 0x0903)
    || (codePoint >= 0x093a && codePoint <= 0x093c)
    || (codePoint >= 0x0941 && codePoint <= 0x0948)
    || codePoint === 0x094d
    || (codePoint >= 0x0951 && codePoint <= 0x0957)
    || (codePoint >= 0x0962 && codePoint <= 0x0963)
    || (codePoint >= 0x0981 && codePoint <= 0x0983)
    || codePoint === 0x09bc
    || (codePoint >= 0x09c1 && codePoint <= 0x09c4)
    || codePoint === 0x09cd
    || (codePoint >= 0x0a01 && codePoint <= 0x0a03)
    || codePoint === 0x0a3c
    || (codePoint >= 0x0a41 && codePoint <= 0x0a42)
    || (codePoint >= 0x0a47 && codePoint <= 0x0a48)
    || (codePoint >= 0x0a4b && codePoint <= 0x0a4d)
    || (codePoint >= 0x0a70 && codePoint <= 0x0a71)
    || (codePoint >= 0x0a81 && codePoint <= 0x0a83)
    || codePoint === 0x0abc
    || (codePoint >= 0x0ac1 && codePoint <= 0x0ac5)
    || (codePoint >= 0x0ac7 && codePoint <= 0x0ac8)
    || codePoint === 0x0acd
    || (codePoint >= 0x0b01 && codePoint <= 0x0b03)
    || codePoint === 0x0b3c
    || (codePoint >= 0x0b3f && codePoint <= 0x0b44)
    || codePoint === 0x0b4d
    || (codePoint >= 0x0b56 && codePoint <= 0x0b57)
    || (codePoint >= 0x0b82 && codePoint <= 0x0b83)
    || (codePoint >= 0x0bc0 && codePoint <= 0x0bcd)
    || (codePoint >= 0x0c00 && codePoint <= 0x0c04)
    || (codePoint >= 0x0c3e && codePoint <= 0x0c44)
    || (codePoint >= 0x0c46 && codePoint <= 0x0c48)
    || (codePoint >= 0x0c4a && codePoint <= 0x0c4d)
    || (codePoint >= 0x0c55 && codePoint <= 0x0c56)
    || (codePoint >= 0x0c81 && codePoint <= 0x0c83)
    || codePoint === 0x0cbc
    || (codePoint >= 0x0cbf && codePoint <= 0x0cc4)
    || (codePoint >= 0x0cc6 && codePoint <= 0x0cc8)
    || (codePoint >= 0x0cca && codePoint <= 0x0ccd)
    || (codePoint >= 0x0d00 && codePoint <= 0x0d03)
    || (codePoint >= 0x0d3b && codePoint <= 0x0d44)
    || (codePoint >= 0x0d46 && codePoint <= 0x0d48)
    || (codePoint >= 0x0d4a && codePoint <= 0x0d4d)
    || codePoint === 0x0d57
    || (codePoint >= 0x0d82 && codePoint <= 0x0d83)
    || codePoint === 0x0dca
    || (codePoint >= 0x0dcf && codePoint <= 0x0dd4)
    || codePoint === 0x0dd6
    || (codePoint >= 0x0dd8 && codePoint <= 0x0ddf)
    || (codePoint >= 0x0e31 && codePoint <= 0x0e3a)
    || (codePoint >= 0x0e47 && codePoint <= 0x0e4e)
    || (codePoint >= 0x0eb1 && codePoint <= 0x0eba)
    || (codePoint >= 0x0ec8 && codePoint <= 0x0ecd)
    || (codePoint >= 0x0f18 && codePoint <= 0x0f19)
    || codePoint === 0x0f35
    || codePoint === 0x0f37
    || codePoint === 0x0f39
    || (codePoint >= 0x0f3e && codePoint <= 0x0f3f)
    || (codePoint >= 0x0f71 && codePoint <= 0x0f84)
    || (codePoint >= 0x0f86 && codePoint <= 0x0f87)
    || (codePoint >= 0x0f8d && codePoint <= 0x0fbc)
    || (codePoint >= 0x102b && codePoint <= 0x103e)
    || (codePoint >= 0x1056 && codePoint <= 0x1059)
    || (codePoint >= 0x105e && codePoint <= 0x1060)
    || (codePoint >= 0x1062 && codePoint <= 0x1064)
    || (codePoint >= 0x1067 && codePoint <= 0x106d)
    || (codePoint >= 0x1071 && codePoint <= 0x1074)
    || (codePoint >= 0x1082 && codePoint <= 0x108d)
    || codePoint === 0x108f
    || (codePoint >= 0x109a && codePoint <= 0x109d)
    || (codePoint >= 0x135d && codePoint <= 0x135f)
    || (codePoint >= 0x1712 && codePoint <= 0x1715)
    || (codePoint >= 0x1732 && codePoint <= 0x1734)
    || (codePoint >= 0x1752 && codePoint <= 0x1753)
    || (codePoint >= 0x1772 && codePoint <= 0x1773)
    || (codePoint >= 0x17b4 && codePoint <= 0x17d3)
    || codePoint === 0x17dd
    || (codePoint >= 0x180b && codePoint <= 0x180f)
    || (codePoint >= 0x1885 && codePoint <= 0x1886)
    || codePoint === 0x18a9
    || (codePoint >= 0x1920 && codePoint <= 0x192b)
    || (codePoint >= 0x1930 && codePoint <= 0x193b)
    || (codePoint >= 0x1a17 && codePoint <= 0x1a1b)
    || (codePoint >= 0x1a55 && codePoint <= 0x1a5e)
    || (codePoint >= 0x1a60 && codePoint <= 0x1a7c)
    || (codePoint >= 0x1a7f && codePoint <= 0x1a7f)
    || (codePoint >= 0x1ab0 && codePoint <= 0x1aff)
    || (codePoint >= 0x1b00 && codePoint <= 0x1b04)
    || (codePoint >= 0x1b34 && codePoint <= 0x1b44)
    || (codePoint >= 0x1b6b && codePoint <= 0x1b73)
    || (codePoint >= 0x1b80 && codePoint <= 0x1b82)
    || (codePoint >= 0x1ba1 && codePoint <= 0x1bad)
    || (codePoint >= 0x1be6 && codePoint <= 0x1bf3)
    || (codePoint >= 0x1c24 && codePoint <= 0x1c37)
    || (codePoint >= 0x1cd0 && codePoint <= 0x1cd2)
    || (codePoint >= 0x1cd4 && codePoint <= 0x1ce8)
    || (codePoint >= 0x1ced && codePoint <= 0x1ced)
    || (codePoint >= 0x1cf2 && codePoint <= 0x1cf4)
    || (codePoint >= 0x1cf7 && codePoint <= 0x1cf9)
    || (codePoint >= 0x1dc0 && codePoint <= 0x1dff)
    || (codePoint >= 0x20d0 && codePoint <= 0x20ff)
    || (codePoint >= 0x2cef && codePoint <= 0x2cf1)
    || (codePoint >= 0x2d7f && codePoint <= 0x2d7f)
    || (codePoint >= 0x2de0 && codePoint <= 0x2dff)
    || (codePoint >= 0xa66f && codePoint <= 0xa672)
    || (codePoint >= 0xa674 && codePoint <= 0xa67d)
    || (codePoint >= 0xa69e && codePoint <= 0xa69f)
    || (codePoint >= 0xa6f0 && codePoint <= 0xa6f1)
    || (codePoint >= 0xa802 && codePoint <= 0xa802)
    || (codePoint >= 0xa806 && codePoint <= 0xa806)
    || (codePoint >= 0xa80b && codePoint <= 0xa80b)
    || (codePoint >= 0xa823 && codePoint <= 0xa827)
    || (codePoint >= 0xa880 && codePoint <= 0xa881)
    || (codePoint >= 0xa8b4 && codePoint <= 0xa8c5)
    || (codePoint >= 0xa8e0 && codePoint <= 0xa8f1)
    || (codePoint >= 0xa926 && codePoint <= 0xa92d)
    || (codePoint >= 0xa947 && codePoint <= 0xa953)
    || (codePoint >= 0xa980 && codePoint <= 0xa983)
    || (codePoint >= 0xa9b3 && codePoint <= 0xa9c0)
    || (codePoint >= 0xa9e5 && codePoint <= 0xa9e5)
    || (codePoint >= 0xaa29 && codePoint <= 0xaa36)
    || (codePoint >= 0xaa43 && codePoint <= 0xaa43)
    || (codePoint >= 0xaa4c && codePoint <= 0xaa4d)
    || (codePoint >= 0xaa7b && codePoint <= 0xaa7d)
    || (codePoint >= 0xaab0 && codePoint <= 0xaab0)
    || (codePoint >= 0xaab2 && codePoint <= 0xaab4)
    || (codePoint >= 0xaab7 && codePoint <= 0xaab8)
    || (codePoint >= 0xaabe && codePoint <= 0xaabf)
    || (codePoint >= 0xaac1 && codePoint <= 0xaac1)
    || (codePoint >= 0xaaeb && codePoint <= 0xaaef)
    || (codePoint >= 0xaaf5 && codePoint <= 0xaaf6)
    || (codePoint >= 0xabe3 && codePoint <= 0xabea)
    || (codePoint >= 0xabec && codePoint <= 0xabed)
    || (codePoint >= 0xfb1e && codePoint <= 0xfb1e)
    || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
    || (codePoint >= 0xfe20 && codePoint <= 0xfe2f)
    || (codePoint >= 0x101fd && codePoint <= 0x101fd)
    || (codePoint >= 0x102e0 && codePoint <= 0x102e0)
    || (codePoint >= 0x10376 && codePoint <= 0x1037a)
    || (codePoint >= 0x10a01 && codePoint <= 0x10a03)
    || (codePoint >= 0x10a05 && codePoint <= 0x10a06)
    || (codePoint >= 0x10a0c && codePoint <= 0x10a0f)
    || (codePoint >= 0x10a38 && codePoint <= 0x10a3a)
    || (codePoint >= 0x10a3f && codePoint <= 0x10a3f)
    || (codePoint >= 0x10ae5 && codePoint <= 0x10ae6)
    || (codePoint >= 0x10d24 && codePoint <= 0x10d27)
    || (codePoint >= 0x10eab && codePoint <= 0x10eac)
    || (codePoint >= 0x10f46 && codePoint <= 0x10f50)
    || (codePoint >= 0x11000 && codePoint <= 0x11002)
    || (codePoint >= 0x11038 && codePoint <= 0x11046)
    || (codePoint >= 0x1107f && codePoint <= 0x11082)
    || (codePoint >= 0x110b0 && codePoint <= 0x110ba)
    || (codePoint >= 0x11100 && codePoint <= 0x11102)
    || (codePoint >= 0x11127 && codePoint <= 0x11134)
    || (codePoint >= 0x11145 && codePoint <= 0x11146)
    || (codePoint >= 0x11173 && codePoint <= 0x11173)
    || (codePoint >= 0x11180 && codePoint <= 0x11182)
    || (codePoint >= 0x111b3 && codePoint <= 0x111c0)
    || (codePoint >= 0x111c9 && codePoint <= 0x111cc)
    || (codePoint >= 0x1122c && codePoint <= 0x11237)
    || (codePoint >= 0x1123e && codePoint <= 0x1123e)
    || (codePoint >= 0x112df && codePoint <= 0x112ea)
    || (codePoint >= 0x11300 && codePoint <= 0x11303)
    || (codePoint >= 0x1133b && codePoint <= 0x1133c)
    || (codePoint >= 0x1133e && codePoint <= 0x11344)
    || (codePoint >= 0x11347 && codePoint <= 0x11348)
    || (codePoint >= 0x1134b && codePoint <= 0x1134d)
    || (codePoint >= 0x11357 && codePoint <= 0x11357)
    || (codePoint >= 0x11362 && codePoint <= 0x11363)
    || (codePoint >= 0x11366 && codePoint <= 0x1136c)
    || (codePoint >= 0x11370 && codePoint <= 0x11374)
    || (codePoint >= 0x11435 && codePoint <= 0x11446)
    || (codePoint >= 0x1145e && codePoint <= 0x1145e)
    || (codePoint >= 0x114b0 && codePoint <= 0x114c3)
    || (codePoint >= 0x115af && codePoint <= 0x115b5)
    || (codePoint >= 0x115b8 && codePoint <= 0x115c0)
    || (codePoint >= 0x11630 && codePoint <= 0x11640)
    || (codePoint >= 0x116ab && codePoint <= 0x116b7)
    || (codePoint >= 0x1171d && codePoint <= 0x1172b)
    || (codePoint >= 0x1182c && codePoint <= 0x1183a)
    || (codePoint >= 0x11930 && codePoint <= 0x11935)
    || (codePoint >= 0x11937 && codePoint <= 0x11938)
    || (codePoint >= 0x1193b && codePoint <= 0x1193e)
    || (codePoint >= 0x11940 && codePoint <= 0x11940)
    || (codePoint >= 0x11942 && codePoint <= 0x11943)
    || (codePoint >= 0x119d1 && codePoint <= 0x119d7)
    || (codePoint >= 0x119da && codePoint <= 0x119e0)
    || (codePoint >= 0x11a01 && codePoint <= 0x11a0a)
    || (codePoint >= 0x11a33 && codePoint <= 0x11a39)
    || (codePoint >= 0x11a3b && codePoint <= 0x11a3e)
    || (codePoint >= 0x11a47 && codePoint <= 0x11a47)
    || (codePoint >= 0x11a51 && codePoint <= 0x11a5b)
    || (codePoint >= 0x11a8a && codePoint <= 0x11a99)
    || (codePoint >= 0x11c2f && codePoint <= 0x11c36)
    || (codePoint >= 0x11c38 && codePoint <= 0x11c3f)
    || (codePoint >= 0x11c92 && codePoint <= 0x11ca7)
    || (codePoint >= 0x11ca9 && codePoint <= 0x11cb6)
    || (codePoint >= 0x11d31 && codePoint <= 0x11d36)
    || (codePoint >= 0x11d3a && codePoint <= 0x11d3a)
    || (codePoint >= 0x11d3c && codePoint <= 0x11d3d)
    || (codePoint >= 0x11d3f && codePoint <= 0x11d45)
    || (codePoint >= 0x11d47 && codePoint <= 0x11d47)
    || (codePoint >= 0x11d8a && codePoint <= 0x11d8e)
    || (codePoint >= 0x11d90 && codePoint <= 0x11d91)
    || (codePoint >= 0x11d93 && codePoint <= 0x11d97)
    || (codePoint >= 0x11ef3 && codePoint <= 0x11ef6)
    || (codePoint >= 0x16af0 && codePoint <= 0x16af4)
    || (codePoint >= 0x16b30 && codePoint <= 0x16b36)
    || (codePoint >= 0x16f4f && codePoint <= 0x16f4f)
    || (codePoint >= 0x16f51 && codePoint <= 0x16f87)
    || (codePoint >= 0x16f8f && codePoint <= 0x16f92)
    || (codePoint >= 0x1bc9d && codePoint <= 0x1bc9e)
    || (codePoint >= 0x1d165 && codePoint <= 0x1d169)
    || (codePoint >= 0x1d16d && codePoint <= 0x1d172)
    || (codePoint >= 0x1d17b && codePoint <= 0x1d182)
    || (codePoint >= 0x1d185 && codePoint <= 0x1d18b)
    || (codePoint >= 0x1d1aa && codePoint <= 0x1d1ad)
    || (codePoint >= 0x1d242 && codePoint <= 0x1d244)
    || (codePoint >= 0x1da00 && codePoint <= 0x1da36)
    || (codePoint >= 0x1da3b && codePoint <= 0x1da6c)
    || (codePoint >= 0x1da75 && codePoint <= 0x1da75)
    || (codePoint >= 0x1da84 && codePoint <= 0x1da84)
    || (codePoint >= 0x1da9b && codePoint <= 0x1da9f)
    || (codePoint >= 0x1daa1 && codePoint <= 0x1daaf)
    || (codePoint >= 0x1e000 && codePoint <= 0x1e006)
    || (codePoint >= 0x1e008 && codePoint <= 0x1e018)
    || (codePoint >= 0x1e01b && codePoint <= 0x1e021)
    || (codePoint >= 0x1e023 && codePoint <= 0x1e024)
    || (codePoint >= 0x1e026 && codePoint <= 0x1e02a)
    || (codePoint >= 0x1e130 && codePoint <= 0x1e136)
    || (codePoint >= 0x1e2ae && codePoint <= 0x1e2ae)
    || (codePoint >= 0x1e2ec && codePoint <= 0x1e2ef)
    || (codePoint >= 0x1e8d0 && codePoint <= 0x1e8d6)
    || (codePoint >= 0x1e944 && codePoint <= 0x1e94a)
    || (codePoint >= 0xe0100 && codePoint <= 0xe01ef)
  );
}

function isVariationSelector(codePoint: number): boolean {
  return (codePoint >= 0xfe00 && codePoint <= 0xfe0f) || (codePoint >= 0xe0100 && codePoint <= 0xe01ef);
}

function isWideCodePoint(codePoint: number): boolean {
  return (
    codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2600 && codePoint <= 0x27bf)
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe19)
    || (codePoint >= 0xfe30 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0xffe0 && codePoint <= 0xffe6)
    || (codePoint >= 0x1f000 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}
