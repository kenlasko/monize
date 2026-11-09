import { getRequestContext } from "../common/request-context";
import { dailyInvestmentsInFlight } from "../net-worth/daily-investments-in-flight";

/**
 * One portfolio valuation per user, scope and minute.
 *
 * Opening the Investments page issues three requests that each need the same
 * valuation -- `GET /portfolio/summary`, `GET /portfolio/allocation/by-tag` and
 * (until this change) `GET /portfolio/tag-keys` -- and they start together, so
 * the server priced the same holdings three times concurrently. The valuation
 * is expensive for a reason that is not going away: live FX priming, a
 * per-holding cost-basis replay, and a day-by-day since-inception result.
 *
 * This memo holds the *in-flight promise*, not only the settled value, which is
 * what makes concurrent callers share one computation rather than three. A
 * rejection is never cached: the entry is dropped so the next caller recomputes
 * instead of inheriting a failure for a minute.
 *
 * It is process memory, deliberately -- but its invalidation is not. A write
 * served by pod A used to leave pod B answering from its own memo for up to
 * {@link PORTFOLIO_SUMMARY_MEMO_TTL_MS}, which a load balancer with no affinity
 * turns into "the trade I just entered is not there" on the very next read.
 * Every invalidation is therefore announced on the `EventBus` and applied by
 * every replica (see {@link PORTFOLIO_SUMMARY_INVALIDATION_CHANNEL}). The bus
 * can drop a message, so the TTL remains the bound rather than the mechanism;
 * `docs/backend/securities-and-providers.md` states what each one covers.
 */

/** Same 60 s window the intraday price cache uses. */
export const PORTFOLIO_SUMMARY_MEMO_TTL_MS = 60_000;

/**
 * Bound on live entries. A key is per user, account scope and currency, so a
 * busy multi-tenant pod can accumulate them; the oldest is evicted first
 * (insertion order, which `Map` preserves).
 */
export const PORTFOLIO_SUMMARY_MEMO_MAX_ENTRIES = 256;

interface MemoEntry {
  /** The user the entry belongs to, so invalidation can find it by owner. */
  readonly userId: string;
  /**
   * When the settled value stops being served, or `null` while the computation
   * is still in flight.
   *
   * The TTL runs from the moment the value exists, not from the moment the
   * work started: a valuation that takes 48 s used to leave 12 s of a 60 s
   * entry, so the next page open paid for the whole walk again (issue #1409).
   * An in-flight entry has no expiry at all, which is what lets every caller
   * that arrives during a long computation share it rather than starting a
   * second one beside it.
   */
  expiresAt: number | null;
  /** In flight or settled -- a shared promise is what de-duplicates callers. */
  readonly value: Promise<unknown>;
}

/** Whether an entry has stopped being servable. In flight is never expired. */
function isExpired(entry: MemoEntry, now: number): boolean {
  return entry.expiresAt !== null && entry.expiresAt <= now;
}

/**
 * The memo key.
 *
 * Every input that can change the answer is part of the key rather than a
 * reason to bypass the memo: the reporting currency (a display currency that is
 * not the preference produces a different summary), the account scope, and the
 * ambient identity. The last one matters because a delegate acting on an
 * owner's accounts reads under the delegate's RLS identity: the answer it
 * computes is not necessarily the answer the owner's own request would compute,
 * so the two must not share an entry.
 */
export function buildPortfolioSummaryMemoKey(
  userId: string,
  accountIds: string[] | undefined,
  reportingCurrency: string,
): string {
  const scope =
    accountIds && accountIds.length > 0
      ? [...accountIds].sort().join(",")
      : "all";
  const ctx = getRequestContext();
  const identity = ctx?.system
    ? "system"
    : `${ctx?.userId ?? "-"}:${ctx?.realUserId ?? "-"}`;
  return `${userId}|${scope}|${reportingCurrency}|${identity}`;
}

/**
 * The key of the valuation the summary is built on, for the same inputs. Its
 * own entry so a surface that needs no returns can share it without the walk;
 * entries are dropped by owner, so every invalidation covers both.
 */
export function buildPortfolioValuationMemoKey(
  userId: string,
  accountIds: string[] | undefined,
  reportingCurrency: string,
): string {
  return `valuation|${buildPortfolioSummaryMemoKey(userId, accountIds, reportingCurrency)}`;
}

class PortfolioSummaryMemo {
  private readonly entries = new Map<string, MemoEntry>();

  /**
   * Return the entry for `key`, or start `compute` and share its promise with
   * every caller that arrives while it runs.
   */
  run<T>(userId: string, key: string, compute: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const existing = this.entries.get(key);
    if (existing && !isExpired(existing, now)) {
      return existing.value as Promise<T>;
    }

    const value = compute();
    const entry: MemoEntry = { userId, expiresAt: null, value };
    this.entries.set(key, entry);
    // The TTL starts when the answer exists. Setting it at the start of the
    // computation charged the wait against the entry's own life: a 48 s
    // valuation was servable for 12 s, so the walk ran again a minute later
    // whether or not anything had changed.
    value.then(
      () => {
        // Only while this entry is still the one being served: an invalidation
        // during the computation dropped it deliberately, and dating a
        // replacement here would put the stale answer back.
        if (this.entries.get(key) === entry) {
          entry.expiresAt = Date.now() + PORTFOLIO_SUMMARY_MEMO_TTL_MS;
        }
      },
      // A failed valuation is not an answer, so it is not remembered. This
      // only removes the entry; the rejection itself still reaches every
      // awaiting caller through the returned promise.
      () => {
        if (this.entries.get(key) === entry) this.entries.delete(key);
      },
    );
    this.evictExpired(now);
    return value;
  }

  /** Drop every entry belonging to one user. */
  invalidateUser(userId: string): void {
    for (const [key, entry] of this.entries) {
      if (entry.userId === userId) this.entries.delete(key);
    }
  }

  /** Drop everything (whole-dataset events, and test isolation). */
  clearAll(): void {
    this.entries.clear();
  }

  /** Live entry count -- for the specs that assert the bound. */
  get size(): number {
    return this.entries.size;
  }

  private evictExpired(now: number): void {
    for (const [key, entry] of this.entries) {
      if (isExpired(entry, now)) this.entries.delete(key);
    }
    // Insertion order: the oldest key goes first once the bound is exceeded.
    // An in-flight entry is evictable here (it has no expiry to reach): every
    // caller already awaiting it still gets its promise, and a caller arriving
    // afterwards starts a fresh computation rather than a full map being able
    // to hold the bound open.
    while (this.entries.size > PORTFOLIO_SUMMARY_MEMO_MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
    }
  }
}

/**
 * The process-wide memo. A module-level singleton rather than a provider so the
 * write paths that must invalidate it (price writes, the post-commit balance
 * seam, restore, demo reset, undo/redo) can call one function without taking a
 * constructor dependency on the securities module.
 */
export const portfolioSummaryMemo = new PortfolioSummaryMemo();

/**
 * The channel an invalidation travels on, so every replica drops the entry and
 * not only the one that served the write.
 *
 * A memo invalidated locally is a valuation that survives on the replica that
 * did not handle the POST, and a load balancer with no affinity sends the very
 * next read there: the Investments page showed the portfolio as it was BEFORE
 * the trade the person had just entered, for up to
 * {@link PORTFOLIO_SUMMARY_MEMO_TTL_MS} (issue #1409, caught by the
 * `CLUSTER_MODE=multi` E2E shard). Reading your own write is not a latency
 * question.
 *
 * What travels is a user id, which is what `EventBus` exists to carry: the
 * recipient drops a cache and recomputes from the database under its own scope,
 * so nothing here is data and nothing is trusted. A lost `NOTIFY` leaves the
 * TTL as the bound, exactly as before this channel existed -- the bus improves
 * the common case and guarantees nothing, which is the contract
 * `common/events/event-bus.interface.ts` states.
 */
export const PORTFOLIO_SUMMARY_INVALIDATION_CHANNEL =
  "portfolio-summary:invalidate";

/** Announces an invalidation to the other replicas; see the bridge. */
export type PortfolioSummaryBroadcast = (
  payload: Record<string, unknown>,
) => void;

let broadcast: PortfolioSummaryBroadcast | null = null;

/**
 * Register (or, with `null`, remove) the announcer.
 *
 * The memo is a module-level singleton precisely so the eight write seams can
 * invalidate it without taking a constructor dependency, so the bus reaches it
 * the same way round: `PortfolioSummaryInvalidationBridge` registers this at
 * module init and removes it at shutdown. Until it does, an invalidation is
 * local and nothing else changes -- which is what a unit test, a script and a
 * cron-only process get.
 */
export function setPortfolioSummaryBroadcast(
  announce: PortfolioSummaryBroadcast | null,
): void {
  broadcast = announce;
}

/**
 * Forget a user's memoized valuations, here and on every other replica.
 *
 * Called from every seam that makes one untrue: a price write, the post-commit
 * balance invalidation (INV-CACHE-001), a restore, a demo reset, an undo or a
 * redo.
 */
export function invalidatePortfolioSummary(userId: string): void {
  portfolioSummaryMemo.invalidateUser(userId);
  // A valuation still running from before the write must not be joined by a
  // read that starts after it (#1888).
  dailyInvestmentsInFlight.invalidateUser(userId);
  announce({ userId });
}

/** Forget every user's valuations: whole-dataset writes with no single owner. */
export function invalidateAllPortfolioSummaries(): void {
  portfolioSummaryMemo.clearAll();
  dailyInvestmentsInFlight.clearAll();
  announce({});
}

/**
 * Apply an invalidation that arrived from another replica.
 *
 * It drops entries and announces nothing: an announcement made here would be
 * answered by every replica that received the first one, and a bus whose
 * messages each produce another message does not converge. A payload with no
 * `userId` is the whole-dataset case, the same one `clearAll` covers, because
 * a message this process does not understand must not be read as "one user".
 */
export function applyPortfolioSummaryInvalidation(
  payload: Record<string, unknown> | undefined,
): void {
  const userId = payload?.userId;
  if (typeof userId === "string" && userId.length > 0) {
    portfolioSummaryMemo.invalidateUser(userId);
    dailyInvestmentsInFlight.invalidateUser(userId);
    return;
  }
  portfolioSummaryMemo.clearAll();
  dailyInvestmentsInFlight.clearAll();
}

/**
 * Tell the other replicas, best-effort.
 *
 * The local drop has already happened, so a bus that is down or absent costs
 * the other replicas their TTL and costs this one nothing. The seams that call
 * this are synchronous and post-commit; a rejection is the bridge's to log,
 * which is why nothing is awaited here.
 */
function announce(payload: Record<string, unknown>): void {
  if (!broadcast) return;
  try {
    broadcast(payload);
  } catch {
    // An announcement nobody could make is the TTL's problem, not the
    // caller's: the write it followed has already committed.
  }
}
