import path from "node:path";
import { displayWidth, fitDisplayLine } from "./markdown.js";

export type ChatMode = "chat" | "plan" | "execute";
export type RuntimeState =
  | "idle"
  | "thinking"
  | "confirming"
  | "applying"
  | "validating"
  | "blocked"
  | "failed";

export type StatusSnapshot = {
  model: string;
  projectRoot: string;
  mode: ChatMode;
  state: RuntimeState;
};

export type WorkStatusState = "running" | "success" | "failed" | "blocked" | "idle";

export type WorkStatusSnapshot = {
  state: WorkStatusState;
  label?: string;
  detail?: string;
  stepIndex?: number;
  totalSteps?: number;
  startedAt?: number;
  stepStartedAt?: number;
  finishedAt?: number;
};

export type StatusBarRenderer = (snapshot: StatusSnapshot) => void;

const ANSI_RESET = "\u001b[0m";
const ANSI_YELLOW = "\u001b[33m";
const ANSI_GREEN = "\u001b[32m";
const ANSI_MAGENTA = "\u001b[35m";
const ANSI_CYAN = "\u001b[36m";
const ANSI_RED = "\u001b[31m";
const ANSI_DIM = "\u001b[2m";

export function deriveChatMode(input: { planModeActive?: boolean; executing?: boolean }): ChatMode {
  if (input.executing) return "execute";
  if (input.planModeActive) return "plan";
  return "chat";
}

export function formatStatusBar(snapshot: StatusSnapshot, columns = process.stdout.columns ?? 100): string {
  const root = compactPath(snapshot.projectRoot);
  const parts = [
    { text: snapshot.model, color: ANSI_YELLOW },
    { text: "      " },
    { text: root, color: ANSI_GREEN },
    { text: "     " },
    { text: snapshot.mode, color: ANSI_MAGENTA },
    { text: " mode" }
  ];
  if (columns <= 0) return renderStatusParts(parts);
  return fitStatusParts(parts, columns);
}

export function formatWorkStatusLine(
  snapshot: WorkStatusSnapshot | undefined,
  columns = process.stdout.columns ?? 100,
  now = Date.now()
): string {
  const work = snapshot ?? { state: "idle" as const };
  const stateColor = work.state === "running" ? ANSI_CYAN
    : work.state === "success" ? ANSI_GREEN
    : work.state === "failed" ? ANSI_RED
    : work.state === "blocked" ? ANSI_YELLOW
    : ANSI_DIM;
  const label = work.label?.trim();
  const step = formatStep(work);
  const timing = formatWorkTiming(work, now);
  const parts = [
    { text: work.state, color: stateColor },
    { text: " " },
    ...(step ? [{ text: `${step} `, color: ANSI_MAGENTA }] : []),
    ...(label ? [{ text: label }] : []),
    ...(work.detail ? [{ text: ` - ${work.detail}` }] : []),
    ...(timing ? [{ text: ` | ${timing}`, color: ANSI_DIM }] : [])
  ];
  if (columns <= 0) return renderStatusParts(parts);
  return fitStatusParts(parts, columns);
}

export class ChatStatusBar {
  private snapshot: StatusSnapshot;
  private readonly renderer?: StatusBarRenderer;

  constructor(snapshot: StatusSnapshot, renderer?: StatusBarRenderer) {
    this.snapshot = snapshot;
    this.renderer = renderer;
  }

  setMode(mode: ChatMode): void {
    this.snapshot = { ...this.snapshot, mode };
    this.render();
  }

  setState(state: RuntimeState): void {
    this.snapshot = { ...this.snapshot, state };
    this.render();
  }

  setModel(model: string): void {
    this.snapshot = { ...this.snapshot, model };
    this.render();
  }

  getSnapshot(): StatusSnapshot {
    return this.snapshot;
  }

  render(): void {
    if (this.renderer) {
      this.renderer(this.snapshot);
      return;
    }
    console.log(formatStatusBar(this.snapshot));
  }
}

function formatStep(snapshot: WorkStatusSnapshot): string {
  if (snapshot.stepIndex === undefined || snapshot.totalSteps === undefined) return "";
  return `${snapshot.stepIndex}/${snapshot.totalSteps}`;
}

function formatWorkTiming(snapshot: WorkStatusSnapshot, now: number): string {
  const finishedAt = snapshot.finishedAt ?? now;
  const parts: string[] = [];
  if (snapshot.stepStartedAt !== undefined) {
    parts.push(`step ${formatWorkElapsed(Math.max(finishedAt - snapshot.stepStartedAt, 0))}`);
  }
  if (snapshot.startedAt !== undefined) {
    parts.push(`total ${formatWorkElapsed(Math.max(finishedAt - snapshot.startedAt, 0))}`);
  }
  return parts.join(" | ");
}

function formatWorkElapsed(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function compactPath(projectRoot: string): string {
  const home = process.env.HOME;
  if (home && projectRoot === home) return "~";
  if (home && projectRoot.startsWith(`${home}${path.sep}`)) {
    return `~${projectRoot.slice(home.length)}`;
  }
  return projectRoot;
}

function color(value: string, ansi: string): string {
  return `${ansi}${value}${ANSI_RESET}`;
}

function renderStatusParts(parts: Array<{ text: string; color?: string }>): string {
  return parts.map((part) => (part.color ? color(part.text, part.color) : part.text)).join("");
}

function fitStatusParts(parts: Array<{ text: string; color?: string }>, columns: number): string {
  let remaining = columns;
  let output = "";
  for (const part of parts) {
    if (remaining <= 0) break;
    const clipped = displayWidth(part.text) > remaining ? fitDisplayLine(part.text, remaining).trimEnd() : part.text;
    if (!clipped) continue;
    output += part.color ? color(clipped, part.color) : clipped;
    remaining -= displayWidth(clipped);
  }
  return fitDisplayLine(output, columns);
}
