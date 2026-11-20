import { Injectable, Logger, Optional } from "@nestjs/common";
import { DataSource } from "typeorm";
import {
  runOutsideActiveScopedManager,
  withScopedDb,
} from "../common/db/scoped-db";
import { withSystemContext } from "../common/db/with-context";
import {
  describeFetchFailure,
  isTransportFailure,
  MAX_FETCH_FAILURE_LENGTH,
} from "../common/http/fetch-failure.util";
import {
  FAILURE_WINDOW_MS,
  ProviderCircuit,
  ProviderCircuitSnapshot,
} from "./provider-circuit";
import {
  ProviderUnavailableError,
  isProviderUnavailable,
} from "./provider-unavailable.error";
import { MIN_OUTAGE_MS, providerLabel } from "./providers";

/**
 * How often a still-failing provider's row is refreshed while it is down.
 *
 * Transitions are always persisted; the failures in between are not, or a dead
 * provider would turn one flood into another (an UPDATE per refused symbol).
 * The heartbeat exists so the alert email can say how many failures and what
 * the latest cause was, rather than quoting the five that opened the breaker.
 */
const HEARTBEAT_MS = 5 * 60_000;

/** At most one failure line per provider per window, however many failed. */
const LOG_INTERVAL_MS = 60_000;

/**
 * What a gate granted. `"probe"` is the exclusive half-open slot, and its holder
 * owes an outcome -- a success, a counted failure, or `releaseProbe`.
 * `"open-gate"` is an ordinary admission through a closed breaker, which owns
 * nothing and must never release.
 */
export type ProviderAdmission = "open-gate" | "probe";

/** Per-provider logging bookkeeping, so the flood becomes one line a minute. */
interface LogState {
  lastLoggedAt: number;
  suppressed: number;
}

/**
 * Availability of the outbound market-data providers: the breaker that stops a
 * dead upstream being called, the one log line that says so, and the durable
 * row an operator gets emailed from.
 *
 * The three responsibilities are here together on purpose -- they are one
 * decision made in three places before (issue #1265): a fetch helper that
 * retried regardless, a catch block that logged a stack per attempt, and an
 * operator who found out from the UI being unusable.
 *
 * Call shape at a provider:
 *
 * ```ts
 * this.health.assertAvailable(PROVIDER);   // throws ProviderUnavailableError
 * try {
 *   const response = await fetch(url, ...);
 *   this.health.recordSuccess(PROVIDER);   // it answered, whatever the status
 * } catch (error) {
 *   this.health.recordFailure(PROVIDER, error);
 *   throw error;
 * }
 * ```
 *
 * and at the outer catch that knows what was being fetched:
 *
 * ```ts
 * this.health.logFailure(this.logger, PROVIDER, `historical prices for ${symbol}`, error);
 * ```
 */
@Injectable()
export class ProviderHealthService {
  private readonly logger = new Logger(ProviderHealthService.name);

  private readonly circuits = new Map<string, ProviderCircuit>();
  private readonly logStates = new Map<string, LogState>();
  private readonly lastPersistedAt = new Map<string, number>();
  /**
   * Providers this process has already recorded a success for.
   *
   * A fresh process starts with a closed breaker, so a success after a restart
   * is not a *transition* and used to write nothing -- leaving a row that says
   * `down` from before the restart, for a provider that is plainly answering.
   * That row is not merely stale: `notifyRecovery` needs `state = 'up'`, so no
   * all-clear could ever be sent, and the outage claim needs
   * `outage_notified_at IS NULL`, so every later outage of that provider would
   * be silently suppressed. One extra write per provider per process closes it.
   */
  private readonly successPersisted = new Set<string>();

  /**
   * One in-flight write per provider, chained. See `persist`: ordering between
   * a `down` and an `up` write is not cosmetic.
   */
  private readonly writeQueues = new Map<string, Promise<void>>();

  /** Errors already counted, so one throw is one failure. See `recordFailure`. */
  private readonly countedFailures = new WeakSet<object>();

  /**
   * @param now injected clock: the windows are the behaviour under test, and a
   *   test that waits out a real minute is a test nobody runs. `@Optional()` is
   *   load-bearing, not decoration: TypeScript emits `Function` as this
   *   parameter's `design:paramtypes` entry, which is not a provider token, so
   *   without it Nest refuses to construct the service and the container never
   *   boots -- while every spec, which uses `new`, stays green.
   *   `provider-health.module.spec.ts` is the regression test.
   */
  constructor(
    private readonly dataSource: DataSource,
    @Optional() private readonly now: () => number = Date.now,
  ) {}

  private circuit(provider: string): ProviderCircuit {
    const existing = this.circuits.get(provider);
    if (existing) return existing;
    const created = new ProviderCircuit(this.now);
    this.circuits.set(provider, created);
    return created;
  }

  /** What this replica currently believes about a provider. */
  snapshot(provider: string): ProviderCircuitSnapshot {
    return this.circuit(provider).snapshot();
  }

  /**
   * Take the request slot, or refuse it by throwing.
   *
   * Called *before* any queue or semaphore the caller has: the point of a
   * refusal is that it costs nothing, and a refusal that first waits behind
   * five in-flight 60-second timeouts costs the caller everything the breaker
   * was meant to save.
   */
  assertAvailable(provider: string): ProviderAdmission {
    const decision = this.circuit(provider).beforeRequest();
    if (decision.allowed) {
      return decision.state === "half-open" ? "probe" : "open-gate";
    }
    throw new ProviderUnavailableError(
      providerLabel(provider),
      decision.retryAfterMs,
      decision.lastFailureReason,
    );
  }

  /**
   * `assertAvailable` for a caller whose contract is a null, not a throw.
   *
   * It **takes the slot**, exactly like `assertAvailable`: this is "may I make
   * one request now", not "is the provider up". A read-only variant would let
   * every caller past the moment an open window elapsed, and the whole point of
   * half-open is that a still-dead provider costs one socket per window. Use
   * `snapshot()` when you genuinely only want to look.
   */
  tryRequest(provider: string): ProviderAdmission | "refused" {
    const decision = this.circuit(provider).beforeRequest();
    if (!decision.allowed) return "refused";
    return decision.state === "half-open" ? "probe" : "open-gate";
  }

  /**
   * Whether the provider answered every request made since `before` was taken.
   *
   * The one test for "may I cache this empty result". A refusal, and a
   * transport failure below the breaker's threshold, both produce exactly the
   * same empty answer as "this symbol has no history" -- and every one of those
   * caches holds for hours, so remembering one turns a two-minute outage into
   * an afternoon of poisoned lookups across a whole portfolio. Before the
   * breaker each poisoning at least cost a real timeout, so it could not fan
   * out; now it is instant, which is what makes this the rule rather than a
   * nicety.
   *
   * Both ends are checked. A breaker that was *already* open when the caller
   * started refused the call outright, and `recordSuccess` does not clear
   * `lastFailureAt` -- so comparing only the timestamps would read a concurrent
   * probe's success as "this caller's request was answered".
   *
   * Deliberately conservative in the other direction too: the counter is
   * shared, so an unrelated concurrent failure costs this caller its cache
   * entry. A missed cache write is the cheap direction.
   */
  answeredSince(provider: string, before: ProviderCircuitSnapshot): boolean {
    if (before.state !== "closed") return false;
    const after = this.circuit(provider).snapshot();
    return (
      after.state === "closed" && after.lastFailureAt === before.lastFailureAt
    );
  }

  /**
   * Give back the probe slot when the attempt produced no evidence about this
   * provider at all. Counts nothing.
   *
   * **Only the caller that was admitted as `"probe"` may call this.** The slot
   * is a single piece of shared state, so a straggler admitted while the
   * breaker was still closed would otherwise free somebody else's probe and let
   * a second one out beside it -- which is the herd the slot exists to prevent.
   * That is why both gates return which kind of admission they granted.
   */
  releaseProbe(provider: string): void {
    this.circuit(provider).releaseProbe();
  }

  /**
   * Whether a request would be refused right now, without taking the slot.
   *
   * For deciding whether to *skip work*, never as the gate before a request:
   * a gate has to take the slot, or every caller pours through the instant an
   * open window elapses. `provider-call.guard.spec.ts` fails if an outbound
   * client uses this in place of `tryRequest`.
   */
  wouldRefuse(provider: string): boolean {
    return this.circuit(provider).wouldRefuse();
  }

  /** The provider answered. Closes the breaker and clears the failure run. */
  recordSuccess(provider: string): void {
    const outcome = this.circuit(provider).recordSuccess();
    const firstOfProcess = !this.successPersisted.has(provider);
    this.successPersisted.add(provider);

    if (outcome.transition === "recovered") {
      this.logger.log(
        `${providerLabel(provider)} is answering again` +
          (outcome.suppressedCalls > 0
            ? `; ${outcome.suppressedCalls} call(s) were refused while it was down`
            : ""),
      );
      this.resetLogState(provider);
    }

    // Written on a recovery, and on this process's first success for the
    // provider whatever the breaker did -- see `successPersisted`. Every later
    // success is silent: a row per priced symbol would be the flood in another
    // form.
    if (outcome.transition === "recovered" || firstOfProcess) {
      this.persist(provider, outcome.snapshot, "up");
    }
  }

  /**
   * Record one failed attempt. Only transport failures count towards the
   * breaker -- a 404 or an unparseable body is this request's problem, and
   * opening the breaker on it would take the provider down for everyone else.
   *
   * @returns whether the failure counted. A caller holding the half-open probe
   *   slot must act on `false`: an uncounted failure is not an outcome, so the
   *   slot has to go back through `releaseProbe` rather than be held for the
   *   probe timeout against a provider nothing has shown to be down.
   */
  recordFailure(provider: string, error: unknown): boolean {
    if (isProviderUnavailable(error)) return false;
    if (!isTransportFailure(error)) return false;
    // One throw is one piece of evidence, however many layers see it: the fetch
    // helper counts what it catches and rethrows, and the caller's catch hands
    // the same object to `logFailure`. A WeakSet keyed on the error itself is
    // what makes the double door safe -- it holds nothing alive, and identity
    // is exactly the question being asked.
    if (typeof error === "object" && error !== null) {
      if (this.countedFailures.has(error)) return true;
      this.countedFailures.add(error);
    }
    const reason = describeFetchFailure(error);
    const circuit = this.circuit(provider);
    const outcome = circuit.recordTransportFailure(reason);

    if (outcome.transition === "opened") {
      const retryAfterMs = Math.max(
        0,
        (outcome.snapshot.retryAt ?? this.now()) - this.now(),
      );
      this.logger.error(
        `${providerLabel(provider)} marked unavailable after ` +
          `${outcome.snapshot.recentFailures} transport failures in ` +
          `${Math.round(FAILURE_WINDOW_MS / 60_000)} minutes; ` +
          `calls are refused locally for ${Math.round(retryAfterMs / 1000)}s. ` +
          `Last failure: ${reason}`,
      );
      this.persist(provider, outcome.snapshot, "down");
      return true;
    }

    // A failure run that has not reached the threshold is not an outage, so
    // nothing is written: the row says "down" only while calls are refused.
    if (outcome.snapshot.state !== "closed" && this.dueForHeartbeat(provider)) {
      this.persist(provider, outcome.snapshot, "down");
    }
    return true;
  }

  /**
   * The provider answers but what it serves is unusable for days: a feed whose
   * newest value is stale, a file whose format changed. The breaker never
   * sees this (only transport failures count, and a once-a-day refresh would
   * not reach its threshold anyway), so the caller that knows the data has been
   * bad for long enough says so, and the row goes `down` for the same alert
   * sweep to report. The episode keeps its first start (see `writeHealth`).
   *
   * The start is backdated by `MIN_OUTAGE_MS`. The sweep only reports an
   * episode with a failure seen that long after it began, which a transport
   * outage proves by failing probe after probe; this caller has already proven
   * days of failure before it calls at all, and its next call is a weekday
   * away. Backdating still understates how long the data has been bad.
   */
  recordDataFailure(provider: string, reason: string): void {
    const now = this.now();
    this.persist(
      provider,
      {
        state: "closed",
        recentFailures: 1,
        failingSince: now - MIN_OUTAGE_MS,
        lastFailureAt: now,
        lastFailureReason: reason.slice(0, MAX_FETCH_FAILURE_LENGTH),
        lastSuccessAt: null,
        suppressedCalls: 0,
        retryAt: null,
      },
      "down",
    );
  }

  /**
   * The provider's data is usable again. Always written: it is called once per
   * successful store (a daily job), so a `down` row left by a data failure --
   * possibly by an earlier process -- is cleared without this process having to
   * remember it.
   */
  recordDataRecovered(provider: string): void {
    const now = this.now();
    this.persist(
      provider,
      {
        state: "closed",
        recentFailures: 0,
        failingSince: null,
        lastFailureAt: null,
        lastFailureReason: null,
        lastSuccessAt: now,
        suppressedCalls: 0,
        retryAt: null,
      },
      "up",
    );
  }

  /**
   * The one place a provider failure is written to the log.
   *
   * Rate-limited per provider, because the flood was never one bad line -- it
   * was a good-enough line repeated for every symbol, chunk and render. A
   * refused call (`ProviderUnavailableError`) prints nothing at all: the
   * breaker already said so once, and the count of what it swallowed is
   * reported on the next line and on recovery.
   */
  logFailure(
    logger: Logger,
    provider: string,
    context: string,
    error: unknown,
  ): void {
    // Counting happens here too, and that is the point: a request can fail
    // *after* its response headers arrived -- `response.json()` rejecting with
    // UND_ERR_BODY_TIMEOUT is a provider that stalls mid-body -- and those
    // never reach the fetch helper's own catch. With `recordSuccess` already
    // fired on the headers, such an outage reset the failure run on every
    // request and the breaker never opened. Recording is idempotent per error
    // object, so a failure the fetch helper already counted is not counted
    // twice on its way through here.
    this.recordFailure(provider, error);

    const state = this.logStates.get(provider) ?? {
      lastLoggedAt: 0,
      suppressed: 0,
    };

    if (isProviderUnavailable(error)) {
      // Counted, not printed -- and not printed at `debug` either. Nothing in
      // this deployment restricts Nest's log levels (`main.ts`), so a debug line
      // per refused call is the same flood one level quieter: 264 lines for one
      // market-index refresh. What was suppressed is reported on the next line
      // that does print, and on recovery.
      this.logStates.set(provider, {
        ...state,
        suppressed: state.suppressed + 1,
      });
      return;
    }

    const now = this.now();
    const label = providerLabel(provider);
    if (now - state.lastLoggedAt < LOG_INTERVAL_MS) {
      this.logStates.set(provider, {
        ...state,
        suppressed: state.suppressed + 1,
      });
      return;
    }

    // The span is measured, not assumed: `suppressed` keeps accumulating until
    // the next line actually prints, which during an open window is the whole
    // window -- quoting a fixed 60s there would describe fifteen minutes of
    // refusals as one minute's worth.
    const quietForMs = state.lastLoggedAt > 0 ? now - state.lastLoggedAt : 0;
    const suffix =
      state.suppressed > 0
        ? ` (${state.suppressed} similar failure(s) suppressed in the previous ` +
          `${Math.max(1, Math.round(quietForMs / 1000))}s)`
        : "";
    logger.warn(
      `${label}: ${context} failed: ${describeFetchFailure(error)}${suffix}`,
    );
    this.logStates.set(provider, { lastLoggedAt: now, suppressed: 0 });
  }

  private resetLogState(provider: string): void {
    this.logStates.set(provider, { lastLoggedAt: 0, suppressed: 0 });
  }

  private dueForHeartbeat(provider: string): boolean {
    const now = this.now();
    const last = this.lastPersistedAt.get(provider) ?? 0;
    return now - last >= HEARTBEAT_MS;
  }

  /**
   * Write the provider's state where the alert cron and the next process can
   * see it.
   *
   * Fire-and-forget and best-effort by construction: availability bookkeeping
   * must never turn a provider outage into a failed request, and it runs
   * `runOutsideActiveScopedManager` so a caller's transaction rolling back does
   * not erase the fact that the provider is down -- the outage is not part of
   * whatever the request was trying to do.
   */
  private persist(
    provider: string,
    snapshot: ProviderCircuitSnapshot,
    state: "up" | "down",
  ): void {
    this.lastPersistedAt.set(provider, this.now());
    // Chained per provider, not fired in parallel. An `opened` and a
    // `recovered` write can be issued milliseconds apart -- a probe failing
    // while another caller succeeds -- and two `void`ed promises can commit in
    // either order. Landing them backwards leaves the row saying `down` for a
    // provider that is answering, which is not a stale display: it produces a
    // false outage email fifteen minutes later, no all-clear (recovery needs
    // `state = 'up'`), and permanent suppression of the next real outage
    // (the claim needs `outage_notified_at IS NULL`).
    const previous = this.writeQueues.get(provider) ?? Promise.resolve();
    const next = previous.then(() =>
      this.writeHealth(provider, snapshot, state),
    );
    this.writeQueues.set(provider, next);
    void next;
  }

  /** The write itself. Never rejects: a caller may `void` it safely. */
  private async writeHealth(
    provider: string,
    snapshot: ProviderCircuitSnapshot,
    state: "up" | "down",
  ): Promise<void> {
    const outageStartedAt =
      snapshot.failingSince !== null ? new Date(snapshot.failingSince) : null;
    const lastFailureAt =
      snapshot.lastFailureAt !== null ? new Date(snapshot.lastFailureAt) : null;
    const lastSuccessAt =
      snapshot.lastSuccessAt !== null ? new Date(snapshot.lastSuccessAt) : null;

    try {
      await runOutsideActiveScopedManager(() =>
        withSystemContext(() =>
          withScopedDb(this.dataSource, (manager) =>
            manager.query(
              `INSERT INTO provider_health (
                 provider, state, recent_failures, outage_started_at,
                 last_failure_at, last_failure_reason, last_success_at
               ) VALUES ($1, $2, $3, $4, $5, $6, $7)
               ON CONFLICT (provider) DO UPDATE SET
                 -- Ordered by observation time, not by arrival. Within a
                 -- process the writes are chained, but two replicas observe
                 -- independently, and a down written from an observation older
                 -- than the stored success (or the reverse) would undo a
                 -- fresher fact. The timestamps come from the observations
                 -- themselves, so the guard holds across replicas too.
                 state = CASE
                   WHEN EXCLUDED.state = 'down'
                        AND provider_health.last_success_at IS NOT NULL
                        AND EXCLUDED.last_failure_at IS NOT NULL
                        AND provider_health.last_success_at > EXCLUDED.last_failure_at
                     THEN provider_health.state
                   WHEN EXCLUDED.state = 'up'
                        AND provider_health.last_failure_at IS NOT NULL
                        AND EXCLUDED.last_success_at IS NOT NULL
                        AND provider_health.last_failure_at > EXCLUDED.last_success_at
                     THEN provider_health.state
                   ELSE EXCLUDED.state
                 END,
                 recent_failures = EXCLUDED.recent_failures,
                 -- An episode already recorded as down keeps its start, so a
                 -- container restarting inside the outage does not reset the
                 -- clock the notification gate reads (issue #1265: the restart
                 -- loop was a symptom of the outage, and a reset start would
                 -- have meant the alert never became due).
                 -- Only a write that opens an episode may set this, and only
                 -- when one is not already recorded. An up write carries no
                 -- start at all, and letting it through nulled the column --
                 -- so a restart between the recovery write and the alert sweep
                 -- left the all-clear reporting an outage that lasted 0 min.
                 outage_started_at = CASE
                   WHEN EXCLUDED.state = 'down'
                        AND (provider_health.state <> 'down'
                             OR provider_health.outage_started_at IS NULL)
                     THEN EXCLUDED.outage_started_at
                   ELSE provider_health.outage_started_at
                 END,
                 last_failure_at = GREATEST(EXCLUDED.last_failure_at, provider_health.last_failure_at),
                 last_failure_reason = COALESCE(EXCLUDED.last_failure_reason, provider_health.last_failure_reason),
                 last_success_at = GREATEST(EXCLUDED.last_success_at, provider_health.last_success_at)`,
              [
                provider,
                state,
                snapshot.recentFailures,
                outageStartedAt,
                lastFailureAt,
                snapshot.lastFailureReason,
                lastSuccessAt,
              ],
            ),
          ),
        ),
      );
    } catch (error) {
      // Availability bookkeeping must never turn a provider outage into a
      // failed request, so the write is best-effort and says so once.
      this.logger.warn(
        `Could not record ${providerLabel(provider)} health: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
