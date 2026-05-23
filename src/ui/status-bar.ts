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

export type StatusBarRenderer = (snapshot: StatusSnapshot) => void;

const ANSI_RESET = "\u001b[0m";
const ANSI_YELLOW = "\u001b[33m";
const ANSI_GREEN = "\u001b[32m";
const ANSI_MAGENTA = "\u001b[35m";

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
