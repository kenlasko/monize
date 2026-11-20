import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from "@nestjs/common";

/** How often the detector checks the clock. */
export const WAKE_TICK_MS = 10_000;

/**
 * A tick this late means the process was suspended, not merely busy.
 *
 * Six missed ticks. An event loop blocked for a minute would also read as a
 * wake, and the cost of that misreading is one deferred refresh -- harmless.
 */
export const WAKE_GAP_MS = 60_000;

/**
 * How long after a wake an outbound job waits before calling anybody.
 *
 * Monize for Windows logged "this PC's network addresses changed" on wake and
 * again thirty seconds later, and every provider lookup in between failed with
 * `getaddrinfo ENOTFOUND`. Two minutes covers that with room to spare.
 */
export const WAKE_SETTLE_MS = 2 * 60_000;

/**
 * Notices that the machine was asleep, so the crons that call providers can
 * wait for the network to come back instead of failing in its first second.
 *
 * A cron that fell due during sleep fires the moment the process resumes --
 * the price refresh (17:00 New York) and the FX refresh (17:05) both ran at
 * 19:54 when a PC woke, in the same second the network adapter came back, so
 * every lookup failed, both breakers opened, and the day's prices and rates
 * were lost until the next run. Nothing tells the backend the machine slept
 * (the desktop shell is a separate process), but sleep leaves a clear trace:
 * a timer ticking every ten seconds suddenly reports a gap of hours.
 *
 * The gap is also checked on demand in `settleDelayMs`, because on resume the
 * overdue cron and this detector's own tick are both due at once and either
 * may run first.
 *
 * Wall-clock time on purpose: what matters is time the network was away, and
 * a monotonic clock does not reliably advance through sleep on every platform.
 */
@Injectable()
export class WakeSettleService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(WakeSettleService.name);
  private timer: NodeJS.Timeout | null = null;
  private lastTickAt: number;
  private lastWakeAt: number | null = null;

  constructor(@Optional() private readonly now: () => number = Date.now) {
    this.lastTickAt = this.now();
  }

  onModuleInit(): void {
    this.lastTickAt = this.now();
    this.timer = setInterval(() => this.tick(), WAKE_TICK_MS);
    // Never what keeps the process alive.
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One check of the clock. Public for tests; the interval calls it. */
  tick(): void {
    const now = this.now();
    const gap = now - this.lastTickAt;
    if (gap > WAKE_GAP_MS) {
      this.lastWakeAt = now;
      this.logger.log(
        `The machine appears to have been asleep for ${Math.round(gap / 1000)}s; ` +
          `provider refreshes wait ${Math.round(WAKE_SETTLE_MS / 1000)}s for the network`,
      );
    }
    this.lastTickAt = now;
  }

  /** How long an outbound job should still wait; 0 when nothing woke recently. */
  settleDelayMs(): number {
    this.tick();
    if (this.lastWakeAt === null) return 0;
    return Math.max(0, this.lastWakeAt + WAKE_SETTLE_MS - this.now());
  }

  /**
   * Run `job` now, or once the network has had `WAKE_SETTLE_MS` since a wake.
   *
   * Call it outside any lease, so a replica waiting here holds nothing another
   * replica could have used.
   */
  async afterWakeSettles(
    name: string,
    job: () => Promise<void>,
  ): Promise<void> {
    const delay = this.settleDelayMs();
    if (delay > 0) {
      this.logger.log(
        `${name}: deferred ${Math.round(delay / 1000)}s after a wake from sleep`,
      );
      await new Promise<void>((resolve) => setTimeout(resolve, delay).unref());
    }
    await job();
  }
}

/**
 * `service.afterWakeSettles`, or `job` at once where no detector was injected
 * (a spec that builds the caller by hand). The callers take the service as an
 * `@Optional()` last parameter; `JobClaimModule` is global, so the running app
 * always supplies it.
 */
export function afterWakeSettles(
  service: WakeSettleService | undefined,
  name: string,
  job: () => Promise<void>,
): Promise<void> {
  return service ? service.afterWakeSettles(name, job) : job();
}
