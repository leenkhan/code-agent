import readline from "node:readline";
import type { ReadStream, WriteStream } from "node:tty";
import { setLoggerSink } from "./logger.js";
import { displayWidth, fitDisplayLine, renderMarkdown, wrapDisplayLine } from "./markdown.js";
import {
  ChatStatusBar,
  formatStatusBar,
  formatWorkStatusLine,
  type ChatMode,
  type RuntimeState,
  type StatusSnapshot,
  type WorkStatusSnapshot,
  type WorkStatusState
} from "./status-bar.js";
import { actionFromConfirmation, defaultConfirmationChoices, type ConfirmationAction, type ConfirmationChoice } from "./selection.js";

export type ChatSelectChoice<T extends string = string> = {
  value: T;
  name: string;
  description?: string;
};

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
  autocompleteCommands?: ChatAutocompleteCommand[];
};

type SelectionState = {
  message: string;
  choices: ChatSelectChoice[];
  index: number;
};

export type ChatAutocompleteCommand = {
  command: string;
  usage: string;
  description: string;
};

export type ChatAutocompleteSuggestion = ChatAutocompleteCommand & {
  completion: string;
};

type AutocompleteState = {
  query: string;
  suggestions: ChatAutocompleteSuggestion[];
  index: number;
};

type ReadState = {
  planModeActive: boolean;
  buffer: string;
  cursor: number;
  autocompleteIndex: number;
  autocompleteHidden: boolean;
};

const INPUT_BG = "\u001b[48;5;238m";
const ANSI_RESET = "\u001b[0m";

let activeTerminal: ChatTerminal | undefined;

export function getActiveChatTerminal(): ChatTerminal | undefined {
  return activeTerminal;
}

export function isPlanExitShortcutKey(key: KeypressLike): boolean {
  return key.name === "tab" && key.shift === true;
}

export function renderChatFrame(input: {
  history: string[];
  historyScrollOffset?: number;
  inputLabel: string;
  inputValue: string;
  selection?: SelectionState;
  autocomplete?: AutocompleteState;
  status: StatusSnapshot;
  workStatus?: WorkStatusSnapshot;
  columns: number;
  rows: number;
}): string[] {
  const columns = Math.max(input.columns, 20);
  const rows = Math.max(input.rows, 8);
  const autocompleteLines = input.autocomplete ? Math.min(input.autocomplete.suggestions.length, 6) : 0;
  const selectionLines = input.selection ? 1 + input.selection.choices.length : 0;
  const fixedLines = 4 + autocompleteLines + selectionLines + 1;
  const historyHeight = Math.max(rows - fixedLines, 0);
  const wrappedHistory = input.history.flatMap((line) => wrapDisplayLine(line, columns));
  const maxHistoryScrollOffset = Math.max(wrappedHistory.length - historyHeight, 0);
  const historyScrollOffset = Math.min(Math.max(input.historyScrollOffset ?? 0, 0), maxHistoryScrollOffset);
  const historyEnd = historyHeight > 0 ? wrappedHistory.length - historyScrollOffset : 0;
  const historyStart = Math.max(historyEnd - historyHeight, 0);
  const historyLines = historyHeight > 0 ? wrappedHistory.slice(historyStart, historyEnd) : [];
  const paddedHistory = [
    ...Array.from({ length: Math.max(historyHeight - historyLines.length, 0) }, () => ""),
    ...historyLines
  ];
  const lines = paddedHistory.map((line) => fitDisplayLine(line, columns));
  lines.push(formatWorkStatusLine(input.workStatus, columns));
  lines.push(formatInputRow(`${input.inputLabel}> ${input.inputValue}`, columns));
  lines.push(formatInputRow("", columns));
  lines.push(formatInputRow("", columns));
  if (input.autocomplete) {
    const visibleSuggestions = input.autocomplete.suggestions.slice(0, 6);
    for (let i = 0; i < visibleSuggestions.length; i += 1) {
      const suggestion = visibleSuggestions[i]!;
      const marker = i === input.autocomplete.index ? ">" : " ";
      lines.push(fitDisplayLine(`${marker} ${suggestion.usage} - ${suggestion.description}`, columns));
    }
  }
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
  private readonly autocompleteCommands: ChatAutocompleteCommand[];
  private history: string[] = [];
  private readState: ReadState | undefined;
  private selection: SelectionState | undefined;
  private previousRawMode: boolean | undefined;
  private workStatus: WorkStatusSnapshot | undefined;
  private historyScrollOffset = 0;
  private workTimer: NodeJS.Timeout | undefined;
  private resizeTimer: NodeJS.Timeout | undefined;
  private readonly handleResize = (): void => {
    this.scheduleResizeRender();
  };
  private started = false;

  constructor(snapshot: StatusSnapshot, streams: ChatTerminalStreams = {}) {
    this.stdin = streams.stdin ?? process.stdin;
    this.stdout = streams.stdout ?? process.stdout;
    this.autocompleteCommands = streams.autocompleteCommands ?? [];
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
    this.stdout.on("resize", this.handleResize);
    process.on("SIGWINCH", this.handleResize);
    this.stdout.write("\u001b[?25l");
    this.render();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    if (activeTerminal === this) activeTerminal = undefined;
    this.clearWorkTimer();
    this.clearResizeTimer();
    setLoggerSink(undefined);
    if (!this.interactive) return;
    this.stdout.removeListener("resize", this.handleResize);
    process.removeListener("SIGWINCH", this.handleResize);
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

  setModel(model: string): void {
    this.status.setModel(model);
  }

  startWork(work: Omit<WorkStatusSnapshot, "state" | "startedAt" | "stepStartedAt" | "finishedAt"> & Partial<Pick<WorkStatusSnapshot, "startedAt" | "stepStartedAt">>): void {
    const now = Date.now();
    const startedAt = work.startedAt ?? now;
    this.workStatus = {
      ...work,
      state: "running",
      startedAt,
      stepStartedAt: work.stepStartedAt ?? now
    };
    this.ensureWorkTimer();
    this.render();
  }

  updateWork(work: Partial<WorkStatusSnapshot>): void {
    const now = Date.now();
    const previous = this.workStatus;
    const state = work.state ?? previous?.state ?? "running";
    const startedAt = work.startedAt ?? previous?.startedAt ?? now;
    const resetStepTimer = state === "running"
      && work.stepStartedAt === undefined
      && (
        (work.stepIndex !== undefined && work.stepIndex !== previous?.stepIndex)
        || (work.label !== undefined && work.label !== previous?.label)
      );
    this.workStatus = {
      ...previous,
      ...work,
      state,
      startedAt,
      stepStartedAt: work.stepStartedAt ?? (resetStepTimer ? now : previous?.stepStartedAt ?? now),
      finishedAt: state === "running" ? undefined : work.finishedAt ?? previous?.finishedAt ?? now
    };
    if (state === "running") this.ensureWorkTimer();
    else this.clearWorkTimer();
    this.render();
  }

  finishWork(
    state: Exclude<WorkStatusState, "running" | "idle">,
    work: Omit<Partial<WorkStatusSnapshot>, "state" | "finishedAt"> = {}
  ): void {
    this.updateWork({ ...work, state, finishedAt: Date.now() });
  }

  clearWork(): void {
    this.workStatus = undefined;
    this.clearWorkTimer();
    this.render();
  }

  append(message: string): void {
    const lines = message.split(/\r?\n/);
    this.history.push(...lines);
    if (this.history.length > 1000) {
      this.history = this.history.slice(-1000);
    }
    this.historyScrollOffset = 0;
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
      this.readState = { planModeActive, buffer: "", cursor: 0, autocompleteIndex: 0, autocompleteHidden: false };
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

    return this.selectOption(message, choices).then((value) => value as ConfirmationAction);
  }

  async selectOption<T extends string>(message: string, choices: ChatSelectChoice<T>[], defaultValue?: T): Promise<T> {
    if (!this.interactive) {
      const { select } = await import("@inquirer/prompts");
      return select<T>({
        message,
        default: defaultValue,
        choices: choices.map((choice) => ({ name: choice.name, value: choice.value, description: choice.description }))
      });
    }

    return new Promise<string>((resolve, reject) => {
      const defaultIndex = defaultValue ? choices.findIndex((choice) => choice.value === defaultValue) : -1;
      this.selection = { message, choices, index: Math.max(defaultIndex, 0) };
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
    }) as Promise<T>;
  }

  private handleInputKey(value: string, key: KeypressLike): ChatInputResult | undefined {
    const state = this.readState;
    if (!state) return undefined;
    if (state.planModeActive && isPlanExitShortcutKey(key)) return { kind: "plan_exit_shortcut" };
    if (key.ctrl && key.name === "c") throw new Error("interrupted");
    if (key.name === "return" || key.name === "enter") return { kind: "line", value: state.buffer };
    if (this.handleHistoryScrollKey(key)) return undefined;
    if (key.name === "escape") {
      if (this.currentAutocomplete()) {
        state.autocompleteHidden = true;
      } else {
        state.buffer = "";
        state.cursor = 0;
        state.autocompleteIndex = 0;
        state.autocompleteHidden = false;
      }
      this.render();
      return undefined;
    }
    if (key.name === "tab") {
      const autocomplete = this.currentAutocomplete();
      const selected = autocomplete?.suggestions[autocomplete.index];
      if (selected) {
        state.buffer = selected.completion;
        state.cursor = state.buffer.length;
        state.autocompleteIndex = 0;
        state.autocompleteHidden = true;
        this.render();
      }
      return undefined;
    }
    if (key.name === "up" || key.name === "down") {
      const autocomplete = this.currentAutocomplete();
      if (autocomplete) {
        const delta = key.name === "up" ? -1 : 1;
        state.autocompleteIndex = (autocomplete.index + delta + autocomplete.suggestions.length) % autocomplete.suggestions.length;
        this.render();
        return undefined;
      }
    }
    if (key.name === "backspace") {
      if (state.cursor > 0) {
        state.buffer = `${state.buffer.slice(0, state.cursor - 1)}${state.buffer.slice(state.cursor)}`;
        state.cursor -= 1;
        state.autocompleteHidden = false;
      }
      this.render();
      return undefined;
    }
    if (key.name === "delete") {
      state.buffer = `${state.buffer.slice(0, state.cursor)}${state.buffer.slice(state.cursor + 1)}`;
      state.autocompleteHidden = false;
      this.render();
      return undefined;
    }
    if (key.name === "left") state.cursor = Math.max(state.cursor - 1, 0);
    else if (key.name === "right") state.cursor = Math.min(state.cursor + 1, state.buffer.length);
    else if (!key.ctrl && !key.meta && value && value >= " ") {
      state.buffer = `${state.buffer.slice(0, state.cursor)}${value}${state.buffer.slice(state.cursor)}`;
      state.cursor += value.length;
      state.autocompleteIndex = 0;
      state.autocompleteHidden = false;
    }
    this.render();
    return undefined;
  }

  private handleSelectionKey(value: string, key: KeypressLike): string | undefined {
    if (!this.selection) return undefined;
    const selection = this.selection;
    if (key.ctrl && key.name === "c") throw new Error("interrupted");
    if (this.handleHistoryScrollKey(key)) return undefined;
    if (key.name === "escape") return selection.choices.find((choice) => choice.value === "cancel")?.value ?? selection.choices[0]?.value;
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
    const autocomplete = this.currentAutocomplete();
    const lines = renderChatFrame({
      history: this.history,
      historyScrollOffset: this.historyScrollOffset,
      inputLabel: readState?.planModeActive ? "you [PLAN]" : "you",
      inputValue: readState?.buffer ?? "",
      selection: this.selection,
      autocomplete,
      status: this.status.getSnapshot(),
      workStatus: this.workStatus,
      columns: this.stdout.columns ?? 100,
      rows: this.stdout.rows ?? 24
    });
    readline.cursorTo(this.stdout as WriteStream, 0, 0);
    readline.clearScreenDown(this.stdout as WriteStream);
    this.stdout.write(lines.join("\n"));
    if (readState && !this.selection) {
      const autocompleteLines = autocomplete ? Math.min(autocomplete.suggestions.length, 6) : 0;
      const selectionLines = 0;
      const fixedLines = 4 + autocompleteLines + selectionLines + 1;
      const historyRows = Math.max((this.stdout.rows ?? 24) - fixedLines, 0);
      const inputRow = historyRows + 1;
      const prefix = `you${readState.planModeActive ? " [PLAN]" : ""}> `;
      const col = Math.min(displayWidth(`${prefix}${readState.buffer.slice(0, readState.cursor)}`), (this.stdout.columns ?? 100) - 1);
      readline.cursorTo(this.stdout as WriteStream, col, inputRow);
      this.stdout.write("\u001b[?25h");
    } else {
      this.stdout.write("\u001b[?25l");
    }
  }

  private handleHistoryScrollKey(key: KeypressLike): boolean {
    if (key.name !== "pageup" && key.name !== "pagedown") return false;
    const metrics = this.historyScrollMetrics();
    if (key.name === "pageup") {
      this.historyScrollOffset = key.ctrl
        ? metrics.maxOffset
        : Math.min(this.historyScrollOffset + metrics.pageSize, metrics.maxOffset);
    } else {
      this.historyScrollOffset = key.ctrl
        ? 0
        : Math.max(this.historyScrollOffset - metrics.pageSize, 0);
    }
    this.render();
    return true;
  }

  private historyScrollMetrics(): { pageSize: number; maxOffset: number } {
    const columns = this.stdout.columns ?? 100;
    const rows = this.stdout.rows ?? 24;
    const autocomplete = this.currentAutocomplete();
    const autocompleteLines = autocomplete ? Math.min(autocomplete.suggestions.length, 6) : 0;
    const selectionLines = this.selection ? 1 + this.selection.choices.length : 0;
    const fixedLines = 4 + autocompleteLines + selectionLines + 1;
    const historyHeight = Math.max(rows - fixedLines, 0);
    const wrappedHistory = this.history.flatMap((line) => wrapDisplayLine(line, Math.max(columns, 20)));
    return {
      pageSize: Math.max(historyHeight - 1, 1),
      maxOffset: Math.max(wrappedHistory.length - historyHeight, 0)
    };
  }

  private ensureWorkTimer(): void {
    if (!this.interactive || this.workTimer) return;
    this.workTimer = setInterval(() => {
      this.render();
    }, 1000);
  }

  private clearWorkTimer(): void {
    if (!this.workTimer) return;
    clearInterval(this.workTimer);
    this.workTimer = undefined;
  }

  private scheduleResizeRender(): void {
    if (!this.interactive || !this.started) return;
    this.clearResizeTimer();
    this.resizeTimer = setTimeout(() => {
      this.resizeTimer = undefined;
      if (this.started) this.render();
    }, 0);
  }

  private clearResizeTimer(): void {
    if (!this.resizeTimer) return;
    clearTimeout(this.resizeTimer);
    this.resizeTimer = undefined;
  }

  private currentAutocomplete(): AutocompleteState | undefined {
    const state = this.readState;
    if (!state || state.autocompleteHidden || this.selection) return undefined;
    const query = slashCommandQuery(state.buffer);
    if (!query) return undefined;
    const exactCommand = this.autocompleteCommands.some((command) => command.command === query);
    if (exactCommand) return undefined;
    const suggestions = this.autocompleteCommands
      .filter((command) => command.command.startsWith(query))
      .map((command) => ({
        ...command,
        completion: completeSlashCommandInput(state.buffer, query, command.command)
      }));
    if (suggestions.length === 0) return undefined;
    const index = Math.min(state.autocompleteIndex, suggestions.length - 1);
    state.autocompleteIndex = index;
    return { query, suggestions, index };
  }
}

function formatInputRow(text: string, columns: number): string {
  return `${INPUT_BG}${fitDisplayLine(text, columns)}${ANSI_RESET}`;
}

function slashCommandQuery(buffer: string): string | undefined {
  if (!buffer.startsWith("/")) return undefined;
  const firstWhitespace = buffer.search(/\s/);
  const tokenEnd = firstWhitespace === -1 ? buffer.length : firstWhitespace;
  return buffer.slice(0, tokenEnd);
}

function completeSlashCommandInput(buffer: string, query: string, command: string): string {
  const suffix = buffer.slice(query.length);
  return `${command}${suffix.startsWith(" ") ? suffix : ` ${suffix}`}`;
}
