import type { LogFormat, LogLevel } from "../config/schema.ts";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export type Fields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, fields?: Fields): void;
  info(msg: string, fields?: Fields): void;
  warn(msg: string, fields?: Fields): void;
  error(msg: string, fields?: Fields): void;
  /** Returns a logger that attaches `fields` to every subsequent line. */
  child(fields: Fields): Logger;
}

/** Receives each log line already rendered as JSON (e.g. a file sink). */
export type LineWriter = (jsonLine: string) => void;

const ANSI = {
  reset: "\x1b[0m",
  colors: { debug: "\x1b[90m", info: "\x1b[36m", warn: "\x1b[33m", error: "\x1b[31m" },
} as const;

class ConsoleLogger implements Logger {
  constructor(
    private readonly level: LogLevel,
    private readonly format: LogFormat,
    private readonly base: Fields,
    private readonly useColor: boolean,
    private readonly fileWriter?: LineWriter,
  ) {}

  debug(msg: string, fields?: Fields): void {
    this.emit("debug", msg, fields);
  }
  info(msg: string, fields?: Fields): void {
    this.emit("info", msg, fields);
  }
  warn(msg: string, fields?: Fields): void {
    this.emit("warn", msg, fields);
  }
  error(msg: string, fields?: Fields): void {
    this.emit("error", msg, fields);
  }

  child(fields: Fields): Logger {
    return new ConsoleLogger(
      this.level,
      this.format,
      { ...this.base, ...fields },
      this.useColor,
      this.fileWriter,
    );
  }

  private emit(level: LogLevel, msg: string, fields?: Fields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.level]) return;
    const record = { ts: new Date().toISOString(), level, msg, ...this.base, ...fields };
    const jsonLine = JSON.stringify(record);

    this.fileWriter?.(jsonLine);

    const line = this.format === "json" ? jsonLine : this.renderText(record);
    if (level === "error" || level === "warn") console.error(line);
    else console.log(line);
  }

  private renderText(record: { ts: string; level: LogLevel; msg: string } & Fields): string {
    const { ts, level, msg, ...fields } = record;
    const tag = this.useColor
      ? `${ANSI.colors[level]}${level.toUpperCase()}${ANSI.reset}`
      : level.toUpperCase();
    const extra = Object.keys(fields).length
      ? " " + Object.entries(fields).map(([k, v]) => `${k}=${renderValue(v)}`).join(" ")
      : "";
    return `${ts} ${tag} ${msg}${extra}`;
  }
}

/** Renders a log field value, quoting strings that contain whitespace. */
function renderValue(v: unknown): string {
  if (typeof v === "string") return /\s/.test(v) ? JSON.stringify(v) : v;
  return JSON.stringify(v);
}

export function createLogger(
  level: LogLevel,
  format: LogFormat,
  fileWriter?: LineWriter,
): Logger {
  const useColor = format === "text" && Deno.stdout.isTerminal();
  return new ConsoleLogger(level, format, {}, useColor, fileWriter);
}
