import { HealthOutcome } from "../health";
import { Logger } from "../logger";
import { exitCause } from "./backend";
import { ChildExit, ChildHandle } from "./child";
import { Clock } from "./clock";
import { messageOf } from "./errors";
import {
  BootOptions,
  describeCause,
  FailureCause,
  FatalFailure,
  ServerName,
  SupervisorStatus,
} from "./types";

/**
 * What happens to a server child that exits after `ready`.
 *
 * It is restarted once, after a backoff: the server only, never db-init or
 * db-migrate, which ran for this launch already. The restart is forgiven when
 * the child then stays up: an exit more than `restartWindowMs` after the
 * previous one is a first exit again. It is fatal when the child exits a
 * second time within the window, exits before it is healthy again, or does not
 * become healthy within its deadline. After a fatal failure nothing is
 * restarted and nothing is stopped: the shell shows the failure and calls
 * `stop()`.
 *
 * An exit is only ever a crash while the supervisor is running and the handle
 * is still the current one for its name, so a child ended by `stop()` is never
 * restarted, and every wait here ends when `signal` aborts.
 */

export interface WatchdogContext {
  readonly clock: Clock;
  readonly logger: Logger;
  readonly options: BootOptions;
  /** Aborted by `stop()`. */
  readonly signal: AbortSignal;
  /** The handle the supervisor currently holds for a server. */
  current(name: ServerName): ChildHandle | undefined;
  /** Start the server again and make its handle the current one. */
  restart(name: ServerName): ChildHandle;
  waitHealthy(
    name: ServerName,
    handle: ChildHandle,
  ): Promise<HealthOutcome<ChildExit>>;
  setStatus(status: SupervisorStatus): void;
  onFatal(failure: FatalFailure): void;
}

export interface Watchdog {
  watch(name: ServerName, handle: ChildHandle): void;
}

export function createWatchdog(context: WatchdogContext): Watchdog {
  const { clock, logger, options, signal } = context;
  const lastExitAt = new Map<ServerName, number>();
  const recovering = new Set<ServerName>();
  let gaveUp = false;

  const active = (): boolean => !signal.aborted && !gaveUp;

  function giveUp(child: ServerName, cause: FailureCause): void {
    gaveUp = true;
    logger.error(
      `The ${child} failed again after its restart (${describeCause(cause)}); not restarting it.`,
    );
    context.onFatal({
      child,
      cause,
      logSource: child,
      logTail: logger.tail(child, options.logTailLines),
    });
  }

  async function recover(child: ServerName): Promise<void> {
    recovering.add(child);
    context.setStatus(`restarting-${child}`);
    await clock.sleep(options.restartBackoffMs, signal);
    // Checked and acted on in one turn: once the new process exists it is the
    // current handle, so a `stop()` arriving next finds it and stops it.
    if (!active()) return;
    const next = context.restart(child);
    watch(child, next);
    const outcome = await context.waitHealthy(child, next);
    if (!active()) return;
    if (outcome.kind === "healthy") {
      recovering.delete(child);
      logger.info(`The ${child} is running again.`);
      if (recovering.size === 0) context.setStatus("ready");
    } else if (outcome.kind === "timeout") {
      giveUp(child, {
        kind: "timeout",
        deadlineMs: outcome.deadlineMs,
        lastStatus: outcome.lastStatus,
        lastError: outcome.lastError,
      });
    }
    // "exited": the watcher on `next` saw the same exit and gave up.
  }

  function watch(child: ServerName, handle: ChildHandle): void {
    void handle.exited.then((exit) => {
      if (!active() || context.current(child) !== handle) return;
      const cause = exitCause(exit);
      const now = clock.now();
      const previous = lastExitAt.get(child);
      const again =
        recovering.has(child) ||
        (previous !== undefined && now - previous <= options.restartWindowMs);
      if (again) {
        giveUp(child, cause);
        return;
      }
      logger.error(
        `The ${child} exited unexpectedly (${describeCause(cause)}); restarting it once.`,
      );
      lastExitAt.set(child, now);
      recover(child).catch((error: unknown) => {
        if (!active()) return;
        giveUp(child, {
          kind: "error",
          message: messageOf(error),
          error,
        });
      });
    });
  }

  return { watch };
}
