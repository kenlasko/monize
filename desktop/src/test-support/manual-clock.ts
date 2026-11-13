import { Clock } from "../supervisor/clock";

/**
 * A clock that only moves when a spec moves it, for specs only. `advance`
 * wakes each due sleeper in time order and lets everything it unblocked run
 * before waking the next, so a chain of timers behaves as it would in real
 * time.
 */

/** Let every promise continuation that is ready run. Not a delay. */
export function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

export interface ManualClock extends Clock {
  advance(ms: number): Promise<void>;
  /** Sleeps nobody has woken or aborted: the timers still armed. */
  readonly pending: number;
}

interface Sleeper {
  readonly at: number;
  readonly order: number;
  readonly wake: () => void;
}

export function manualClock(): ManualClock {
  let now = 0;
  let order = 0;
  let sleepers: readonly Sleeper[] = [];

  function nextDue(limit: number): Sleeper | undefined {
    return sleepers
      .filter((sleeper) => sleeper.at <= limit)
      .sort((a, b) => a.at - b.at || a.order - b.order)[0];
  }

  return {
    now: () => now,
    sleep(ms, signal) {
      return new Promise<void>((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        const sleeper: Sleeper = {
          at: now + ms,
          order: order++,
          wake: () => {
            sleepers = sleepers.filter((other) => other !== sleeper);
            signal?.removeEventListener("abort", sleeper.wake);
            resolve();
          },
        };
        sleepers = [...sleepers, sleeper];
        signal?.addEventListener("abort", sleeper.wake, { once: true });
      });
    },
    async advance(ms) {
      const target = now + ms;
      await flush();
      for (
        let due = nextDue(target);
        due !== undefined;
        due = nextDue(target)
      ) {
        now = Math.max(now, due.at);
        due.wake();
        await flush();
      }
      now = target;
    },
    get pending() {
      return sleepers.length;
    },
  };
}
