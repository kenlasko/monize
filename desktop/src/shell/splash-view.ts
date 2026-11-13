import { AppPathsError } from "../app-paths";
import { ConfigError } from "../app-config";
import { ChildEnvError } from "../env";
import { formatConsoleLine, LogRecord } from "../logger";
import { PortError } from "../ports";
import { SecretError } from "../secrets";
import {
  BootFailure,
  describeCause,
  SupervisorStatus,
} from "../supervisor/types";
import { STATUS_TEXT, TEXT } from "./strings";

/**
 * What the splash window shows, as plain data sent over IPC. The page renders
 * every field with `textContent`, so nothing here is ever markup.
 */

export interface SplashView {
  readonly title: string;
  readonly detail: string;
  /** Log lines, oldest first; empty while booting. */
  readonly lines: readonly string[];
  readonly retryLabel: string;
  readonly quitLabel: string;
  readonly canRetry: boolean;
  readonly canQuit: boolean;
  /** True while work is in progress (the page shows a spinner). */
  readonly busy: boolean;
}

/** Caps what reaches the page, whatever the supervisor's tail length. */
export const MAX_SPLASH_LINES = 50;
export const MAX_SPLASH_LINE_CHARS = 500;

const LABELS = { retryLabel: TEXT.retry, quitLabel: TEXT.quit } as const;

function clip(line: string): string {
  return line.length > MAX_SPLASH_LINE_CHARS
    ? `${line.slice(0, MAX_SPLASH_LINE_CHARS)}...`
    : line;
}

export function splashLines(records: readonly LogRecord[]): readonly string[] {
  return records
    .slice(-MAX_SPLASH_LINES)
    .map((record) => clip(formatConsoleLine(record).trimEnd()));
}

export function preparingView(): SplashView {
  return {
    title: STATUS_TEXT.idle,
    detail: TEXT.splashPreparing,
    lines: [],
    ...LABELS,
    canRetry: false,
    canQuit: false,
    busy: true,
  };
}

export function statusView(status: SupervisorStatus): SplashView {
  return {
    title: STATUS_TEXT[status],
    detail: "",
    lines: [],
    ...LABELS,
    canRetry: false,
    canQuit: false,
    busy: true,
  };
}

/** A boot step failed; the supervisor has stopped what it started. */
export function failedView(failure: BootFailure): SplashView {
  return {
    title: TEXT.bootFailedTitle,
    detail: `${TEXT.bootFailedAt} ${STATUS_TEXT[failure.step]} (${describeCause(failure.cause)})`,
    lines: splashLines(failure.logTail),
    ...LABELS,
    canRetry: true,
    canQuit: true,
    busy: false,
  };
}

/**
 * The typed errors of the modules `createRuntime` calls carry a message
 * written for the person and free of any secret, so it is shown as it is.
 */
export function isPresentableError(error: unknown): boolean {
  return (
    error instanceof ConfigError ||
    error instanceof SecretError ||
    error instanceof PortError ||
    error instanceof ChildEnvError ||
    error instanceof AppPathsError
  );
}

/** `createRuntime` threw: nothing was started, and Retry would fail the same way. */
export function startupErrorView(error: unknown): SplashView {
  const message = error instanceof Error ? error.message : String(error);
  const detail = isPresentableError(error)
    ? message
    : `${TEXT.startupErrorUnknown} ${message}`;
  return {
    title: TEXT.startupErrorTitle,
    detail,
    lines: [],
    ...LABELS,
    canRetry: false,
    canQuit: true,
    busy: false,
  };
}
