import type { LogLevel } from "./logger";

/**
 * One line of a child's output as the logger records it.
 *
 * Every record already carries its own ISO time, level and source, so what a
 * child prints in front of its message only repeats them, worse: the NestJS
 * `ConsoleLogger` writes `[Nest] <pid>  - <local date>   <LEVEL> [<Context>]
 * <message>` wrapped in terminal colour codes, and sends a WARN to stdout,
 * which the supervisor records at `info`. So a line is cleaned here before it
 * becomes a record: escape sequences are removed from every line (they are
 * noise in a file and in the log viewer), and a Nest line gives up its pid and
 * local date and lends its level to the record, keeping `[<Context>]` in front
 * of the message. Any other line, a stack frame of a Nest error included, keeps
 * its text and the level of the stream it came from.
 */

export interface ChildLine {
  readonly level: LogLevel;
  readonly msg: string;
}

// CSI sequences (colours, cursor moves), OSC sequences (titles, links) ended
// by BEL or ST, and the remaining two-byte escapes (ECMA-48 Fp, Fe and Fs).
const ESCAPE_SEQUENCE =
  // eslint-disable-next-line no-control-regex
  /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[0-~]/g;

/**
 * `[Nest] 17136  - 2026-11-15, 11:33:34 p.m.    WARN [DbInit] message`. The
 * date is `Intl.DateTimeFormat` in the machine's locale, so it is matched as
 * whatever sits between the pid and the level.
 */
const NEST_LINE =
  /^\[Nest\] \d+\s+-\s+.*?\s(LOG|ERROR|WARN|DEBUG|VERBOSE|FATAL) (.*)$/;

const NEST_LEVELS: Readonly<Record<string, LogLevel>> = {
  LOG: "info",
  ERROR: "error",
  WARN: "warn",
  DEBUG: "debug",
  VERBOSE: "debug",
  FATAL: "error",
};

export function stripEscapes(line: string): string {
  return line.replace(ESCAPE_SEQUENCE, "");
}

export function normalizeChildLine(line: string, level: LogLevel): ChildLine {
  const text = stripEscapes(line);
  const nest = NEST_LINE.exec(text);
  if (nest === null) return { level, msg: text };
  return { level: NEST_LEVELS[nest[1]], msg: nest[2] };
}
