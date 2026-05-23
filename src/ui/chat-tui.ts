import readline from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";
import { setLoggerSink } from "./logger.js";
import { displayWidth, fitDisplayLine, renderMarkdown, wrapDisplayLine } from "./markdown.js";
import { ChatStatusBar, formatStatusBar, type ChatMode, type RuntimeState, type StatusSnapshot } from "./status-bar.js";
import { actionFromConfirmation, defaultConfirmationChoices, type ConfirmationAction, type ConfirmationChoice } from "./selection.js";

export type ChatInputResult =
  | { kind: "line"; value: string }
  | { kind: "plan_exit_shortcut" };

export type KeypressLike = {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
};

export type ChatTerminalStreams = {
  stdin?: NodeJS.ReadStream;
  stdout?: NodeJS.WriteStream;
};

type SelectionState = {
  message: string;
  choices: ConfirmationChoice[];
  index: number;
};

type ReadState = {
  planModeActive: boolean;
  buffer: string;
  cursor: number;
};

const INPUT_BG = "\u001b[48;5;238m";
const ANSI_RESET = "\u001b[0m";

let activeTerminal: ChatTerminal | undefined;

export function getActiveChatTerminal(): ChatTerminal | undefined {
  return activeTerminal;
}

export function isPlanExitShortcutKey(key: KeypressLike): boolean {
  return (key.name === "tab" && key.shift === true) || key.sequence === "\u001b[Z";
}

export function renderChatFrame(input: {
  history: string[];
  inputLabel: string;
  inputValue: string;
  selection?: SelectionState;
  status: StatusSnapshot;
  columns: number;
  rows: number;
}): string[] {
  const columns = Math.max(input.columns, 20);
  const rows = Math.max(input.rows, 8);
  const selectionLines = input.selection ? 1 + input.selection.choices.length : 0;
  const fixedLines = 3 + selectionLines + 1;
  const historyHeight = Math.max(rows - fixedLines, 1);
  const historyLines = input.history
    .flatMap((line) => wrapDisplayLine(line, columns))
    .slice(-historyHeight);
  const paddedHistory = [
    ...Array.from({ length: Math.max(historyHeight - historyLines.length, 0) }, () => ""),
    ...historyLines
  ];
  const lines = paddedHistory.map((line) => fitDisplayLine(line, columns));
  lines.push(formatInputRow(`${input.inputLabel}> ${input.inputValue}`, columns));
  lines.push(formatInputRow("", columns));
  lines.push(formatInputRow("", columns));
  if (input.selection) {
    lines.push(fitDisplayLine(`? ${input.selection.message}`, columns));
    for (let i = 0; i < input.selection.choices.length; i += 1) {
      const choice = input.selection.choices[i]!;
      const marker = i === input.selection.index ? ">" : " ";
      const description = choice.description ? ` - ${choice.description}` : "";
      lines.push(fitDisplayLine(`${marker} ${choice.name}${description}`, columns));
    }
  }
  lines.push(formatStatusBar(input.status, columns));
  return lines;
}

export class ChatTerminal {
  readonly status: ChatStatusBar;
  private readonly stdin: NodeJS.ReadStream;
  private readonly stdout: NodeJS.WriteStream;
  private readonly interactive: boolean;
  private history: string[] = [];
  private readState: ReadState | undefined;
  private selection: SelectionState | undefined;
  private previousRawMode: boolean | undefined;
  private started = false;

  constructor(snapshot: StatusSnapshot, streams: ChatTerminalStreams = {}) {
    this.stdin = streams.stdin ?? process.stdin;
    this.stdout = streams.stdout ?? process.stdout;
    this.interactive = Boolean(this.stdin.isTTY && this.stdout.isTTY);
    this.status = new ChatStatusBar(snapshot, () => this.render());
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (!this.interactive) return;
    activeTerminal = this;
    setLoggerSink((_level, message) => {
      this.append(message);
    });
    this.previousRawMode = (this.stdin as ReadStream).isRaw;
    readline.emitKeypressEvents(this.stdin);
    if (typeof (this.stdin as ReadStream).setRawMode === "function") {
      (this.stdin as ReadStream).setRawMode(true);
    }
    this.stdout.write("\u001b[?25l");
    this.render();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (activeTerminal === this) activeTerminal = undefined;
    setLoggerSink(undefined);
    if (!this.interactive) return;
    const ttyStdin = this.stdin as ReadStream;
    if (typeof ttyStdin.setRawMode === "function") {
      ttyStdin.setRawMode(this.previousRawMode ?? false);
    }
    this.stdin.pause();
    readline.cursorTo(this.stdout as WriteStream, 0, 0);
    readline.clearScreenDown(this.stdout as WriteStream);
    this.stdout.write(`${this.history.join("\n")}\n\u001b[0m\u001b[?25h`);
  }

  setMode(mode: ChatMode): void {
    this.status.setMode(mode);
  }

  setState(state: RuntimeState): void {
    this.status.setState(state);
  }

  append(message: string): void {
    const lines = message.split(/\r?\n/);
    this.history.push(...lines);
    if (this.history.length > 1000) {
      this.history = this.history.slice(-1000);
    }
    this.render();
  }

  appendMarkdown(message: string): void {
    if (!this.interactive) {
      console.log(message);
      return;
    }
    this.append(renderMarkdown(message));
  }

  async readInput(planModeActive: boolean): Promise<ChatInputResult> {
    if (!this.interactive) {
      const { input } = await import("@inquirer/prompts");
      const message = planModeActive ? "you [PLAN - Shift+Tab exits]" : "you";
      return { kind: "line", value: await input({ message }) };
    }

    return new Promise<ChatInputResult>((resolve, reject) => {
      this.readState = { planModeActive, buffer: "", cursor: 0 };
      const onKeypress = (value: string, key: KeypressLike): void => {
        try {
          const result = this.handleInputKey(value, key);
          if (!result) return;
          this.stdin.removeListener("keypress", onKeypress);
          const state = this.readState;
          this.readState = undefined;
          this.render();
          if (result.kind === "line" && state) {
            this.append(`${state.planModeActive ? "you [PLAN]" : "you"}: ${result.value}`);
          }
          resolve(result);
        } catch (error) {
          this.stdin.removeListener("keypress", onKeypress);
          this.readState = undefined;
          reject(error);
        }
      };
      this.stdin.on("keypress", onKeypress);
      this.render();
    });
  }

  async confirmAction(message: string, choices: ConfirmationChoice[] = defaultConfirmationChoices()): Promise<ConfirmationAction> {
    if (!this.interactive) {
      const { confirm } = await import("@inquirer/prompts");
      return actionFromConfirmation(await confirm({ message, default: false }), choices);
    }

    return new Promise<ConfirmationAction>((resolve, reject) => {
      this.selection = { message, choices, index: 0 };
      const onKeypress = (value: string, key: KeypressLike): void => {
        try {
          const result = this.handleSelectionKey(value, key);
          if (!result) return;
          this.stdin.removeListener("keypress", onKeypress);
          this.selection = undefined;
          this.append(`selection: ${message} -> ${result}`);
          resolve(result);
        } catch (error) {
          this.stdin.removeListener("keypress", onKeypress);
          this.selection = undefined;
          reject(error);
        } finally {
          this.render();
        }
      };
      this.stdin.on("keypress", onKeypress);
      this.render();
    });
  }

  private handleInputKey(value: string, key: KeypressLike): ChatInputResult | undefined {
    const state = this.readState;
    if (!state) return undefined;
    if (state.planModeActive && isPlanExitShortcutKey(key)) return { kind: "plan_exit_shortcut" };
    if (key.ctrl && key.name === "c") throw new Error("interrupted");
    if (key.name === "return" || key.name === "enter") return { kind: "line", value: state.buffer };
    if (key.name === "escape") {
      state.buffer = "";
      state.cursor = 0;
      this.render();
      return undefined;
    }
    if (key.name === "backspace") {
      if (state.cursor > 0) {
        state.buffer = `${state.buffer.slice(0, state.cursor - 1)}${state.buffer.slice(state.cursor)}`;
        state.cursor -= 1;
      }
      this.render();
      return undefined;
    }
    if (key.name === "delete") {
      state.buffer = `${state.buffer.slice(0, state.cursor)}${state.buffer.slice(state.cursor + 1)}`;
      this.render();
      return undefined;
    }
    if (key.name === "left") state.cursor = Math.max(state.cursor - 1, 0);
    else if (key.name === "right") state.cursor = Math.min(state.cursor + 1, state.buffer.length);
    else if (!key.ctrl && !key.meta && value && value >= " ") {
      state.buffer = `${state.buffer.slice(0, state.cursor)}${value}${state.buffer.slice(state.cursor)}`;
      state.cursor += value.length;
    }
    this.render();
    return undefined;
  }

  private handleSelectionKey(value: string, key: KeypressLike): ConfirmationAction | undefined {
    if (!this.selection) return undefined;
    const selection = this.selection;
    if (key.ctrl && key.name === "c") throw new Error("interrupted");
    if (key.name === "escape") return selection.choices.find((choice) => choice.value === "cancel")?.value ?? "cancel";
    if (key.name === "return" || key.name === "enter") return selection.choices[selection.index]?.value;
    if (key.name === "up" || value === "k") {
      selection.index = (selection.index - 1 + selection.choices.length) % selection.choices.length;
      this.render();
      return undefined;
    }
    if (key.name === "down" || key.name === "tab" || value === "j") {
      selection.index = (selection.index + 1) % selection.choices.length;
      this.render();
      return undefined;
    }
    const lower = value.toLowerCase();
    const shortcut = selection.choices.find((choice) => choice.name.toLowerCase().startsWith(lower));
    if (shortcut) return shortcut.value;
    return undefined;
  }

  private render(): void {
    if (!this.interactive) return;
    const readState = this.readState;
    const lines = renderChatFrame({
      history: this.history,
      inputLabel: readState?.planModeActive ? "you [PLAN]" : "you",
      inputValue: readState?.buffer ?? "",
      selection: this.selection,
      status: this.status.getSnapshot(),
      columns: this.stdout.columns ?? 100,
      rows: this.stdout.rows ?? 24
    });
    readline.cursorTo(this.stdout as WriteStream, 0, 0);
    readline.clearScreenDown(this.stdout as WriteStream);
    this.stdout.write(lines.join("\n"));
    if (readState && !this.selection) {
      const historyRows = Math.max((this.stdout.rows ?? 24) - 4, 1);
      const prefix = `you${readState.planModeActive ? " [PLAN]" : ""}> `;
      const col = Math.min(displayWidth(`${prefix}${readState.buffer.slice(0, readState.cursor)}`), (this.stdout.columns ?? 100) - 1);
      readline.cursorTo(this.stdout as WriteStream, col, historyRows);
      this.stdout.write("\u001b[?25h");
    } else {
      this.stdout.write("\u001b[?25l");
    }
  }
}

function formatInputRow(text: string, columns: number): string {
  return `${INPUT_BG}${fitDisplayLine(text, columns)}${ANSI_RESET}`;
}
