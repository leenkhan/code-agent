export type CompactOutputOptions = {
  maxLines?: number;
  maxLineLength?: number;
};

const noisyLinePatterns = [
  /^Requirement already satisfied:/,
  /^Looking in indexes:/,
  /^\[notice\]/,
  /^\d{4}-\d{2}-\d{2} .* sqlalchemy\.engine\.Engine /,
  /^INFO sqlalchemy\.engine\.Engine /,
  /^\[raw sql\]/,
  /^PRAGMA /,
  /^CREATE (TABLE|INDEX|UNIQUE INDEX) /,
  /^\s*\* 'orm_mode' has been renamed/,
  /^.*pydantic\/_internal\/_config\.py.*UserWarning:/,
  /^INFO:?\s+127\.0\.0\.1:/,
  /^INFO:?\s+Started reloader process /,
  /^INFO:?\s+Started server process /,
  /^INFO:?\s+Waiting for application startup\./,
  /^INFO:?\s+Application startup complete\./
];

const interestingLinePatterns = [
  /^Collecting /,
  /^Downloading /,
  /^Installing collected packages:/,
  /^Successfully installed /,
  /^Building wheel for /,
  /^Successfully built /,
  /^Compiling /,
  /^Built /,
  /^Running /,
  /^PASSED\b/,
  /^FAILED\b/,
  /^ERROR\b/,
  /^ERROR:/,
  /^Traceback \(most recent call last\):/,
  /^Started /,
  /^Stopped /,
  /^Shutting down/,
  /^Finished server process /,
  /^Stopping reloader process /,
  /^Command result$/,
  /^External services$/
];

export function compactOutput(output: string, options: CompactOutputOptions = {}): string {
  const maxLines = options.maxLines ?? 6;
  const maxLineLength = options.maxLineLength ?? 180;
  const rawLines = output
    .replace(/\r/g, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0);

  if (rawLines.length === 0) return "";

  const filtered = rawLines.filter((line) => !noisyLinePatterns.some((pattern) => pattern.test(line.trim())));
  const lines = filtered.length > 0 ? filtered : rawLines;
  const selected = selectRelevantLines(lines, maxLines);
  const compacted = selected.map((line) => truncateLine(line, maxLineLength));
  const hidden = Math.max(lines.length - selected.length, 0);
  if (hidden > 0) {
    compacted.push(`... ${hidden} more line(s) hidden`);
  }
  return compacted.join("\n");
}

export function formatCompactCommandResult(input: {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}): string {
  const parts = [`$ ${input.command}`, `exitCode: ${input.exitCode}`];
  const stdout = compactOutput(input.stdout);
  const stderr = compactOutput(input.stderr, { maxLines: 8 });
  if (stdout) parts.push("stdout:", stdout);
  if (stderr) parts.push("stderr:", stderr);
  return parts.join("\n");
}

function truncateLine(line: string, maxLength: number): string {
  return line.length > maxLength ? `${line.slice(0, maxLength - 1)}...` : line;
}

function selectRelevantLines(lines: string[], maxLines: number): string[] {
  if (lines.length <= maxLines) {
    return lines;
  }

  const ranked = lines.map((line, index) => ({
    line,
    index,
    score: scoreLine(line, index, lines.length)
  }));
  const selectedIndexes = new Set<number>();

  for (const item of ranked.filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.index - b.index)) {
    selectedIndexes.add(item.index);
    if (selectedIndexes.size >= maxLines) break;
  }

  if (selectedIndexes.size < maxLines) {
    selectedIndexes.add(0);
  }
  if (selectedIndexes.size < maxLines) {
    selectedIndexes.add(lines.length - 1);
  }

  for (const index of [1, 2, 3, lines.length - 2, lines.length - 3]) {
    if (selectedIndexes.size >= maxLines) break;
    if (index >= 0 && index < lines.length) {
      selectedIndexes.add(index);
    }
  }

  const ordered = [...selectedIndexes]
    .sort((a, b) => a - b)
    .slice(0, maxLines)
    .map((index) => lines[index]);

  return ordered.length > 0 ? ordered : lines.slice(0, maxLines);
}

function scoreLine(line: string, index: number, total: number): number {
  const trimmed = line.trim();
  let score = 0;
  if (interestingLinePatterns.some((pattern) => pattern.test(trimmed))) score += 10;
  if (/Successfully|Failed|Error|Traceback|Started|Stopped|PASSED|FAILED|WARNING|WARNING:/.test(trimmed)) score += 5;
  if (index === 0 || index === total - 1) score += 2;
  if (trimmed.length < 120) score += 1;
  return score;
}
