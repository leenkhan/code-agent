import chalk from "chalk";

export type LoggerLevel = "info" | "success" | "warn" | "error" | "heading";
export type LoggerSink = (level: LoggerLevel, message: string) => void;

let sink: LoggerSink | undefined;

export function setLoggerSink(nextSink: LoggerSink | undefined): void {
  sink = nextSink;
}

function write(level: LoggerLevel, message: string, fallback: (message: string) => void): void {
  if (sink) {
    sink(level, message);
    return;
  }
  fallback(message);
}

export const logger = {
  info(message: string): void {
    write("info", message, console.log);
  },
  success(message: string): void {
    write("success", chalk.green(message), console.log);
  },
  warn(message: string): void {
    write("warn", chalk.yellow(message), console.warn);
  },
  error(message: string): void {
    write("error", chalk.red(message), console.error);
  },
  heading(message: string): void {
    write("heading", chalk.bold(message), console.log);
  }
};
