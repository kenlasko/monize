import { getMonthEndYMD, todayYMD } from "../date-utils";
import { BOUNDARY_LAG_DAYS, withLeadDays } from "./price-boundary.util";

/**
 * The two halves of an **on-demand historical fill**: the window one provider
 * call asks for, and the memory of a call that came back with nothing.
 *
 * A point-in-time report can only present a figure it can price and convert,
 * and for a date years back the database frequently holds neither: the daily
 * refreshes write today, and the one-off backfills stop at the first row they
 * find. So the report asks the provider for what it is missing, at read time.
 * Exchange rates and security prices do exactly the same thing for exactly the
 * same reason, which is why the policy lives here once rather than twice.
 */

/**
 * The window one fill covers for a date: the whole calendar month, with
 * `BOUNDARY_LAG_DAYS` of lead so the first days of the month have an
 * observation to carry forward from, and never running past today because the
 * market has not been there yet.
 *
 * A month rather than a day because one provider call returns the whole daily
 * series for whatever period it is asked for and costs the same either way.
 * Every other date in that month is then a database read -- a user stepping a
 * report back through a year pays twelve calls per series rather than three
 * hundred.
 */
export function monthFetchWindow(date: string): [string, string] {
  const [year, month] = date.split("-").map(Number);
  const start = withLeadDays(`${date.slice(0, 7)}-01`, BOUNDARY_LAG_DAYS);
  const monthEnd = getMonthEndYMD(year, month);
  const today = todayYMD();
  return [start, monthEnd > today ? today : monthEnd];
}

/**
 * How long a "the provider has nothing here" answer is trusted before it is
 * asked again.
 *
 * Without it, a report dated before a series begins re-asks the provider on
 * every page load and every refresh -- the one case where the fetch can never
 * succeed is the one that would repeat forever.
 *
 * Half an hour rather than a day because **the provider layer cannot tell an
 * absence from a failure**: a 429, a timeout and "no such history" all arrive
 * as null. So every entry here might be a transient error remembered as a
 * permanent fact, and the number answers "how long may a rate-limited fetch
 * keep a series off the report" -- not "how long is missing history missing".
 * Short enough that a user who reloads gets a real retry, long enough that
 * reloading cannot hammer the provider.
 */
export const EMPTY_WINDOW_TTL_MS = 30 * 60 * 1000;

/** Bound on the memory, so a long-lived process cannot grow it forever. */
export const EMPTY_WINDOW_CACHE_MAX = 2000;

/**
 * Subjects (a currency pair, a security) whose month a provider answered with
 * nothing, and when that answer expires.
 *
 * **This is a cache, not a guard.** It gates no work and coordinates nothing:
 * a replica that has not seen a miss simply makes the fetch, and the write it
 * would perform is an idempotent upsert. Process-local state beside a cron is
 * a real defect when it decides whether work happens (`docs/cron-jobs.md`; the
 * scan in `backend/src/common/db/derived-state-writers.guard.spec.ts` names the
 * two incidents) -- so anything held here must stay in the category where
 * losing an entry costs a round trip and changes no row.
 */
export class EmptyWindowMemory {
  private readonly expiries = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = EMPTY_WINDOW_TTL_MS,
    private readonly max: number = EMPTY_WINDOW_CACHE_MAX,
  ) {}

  /** Whether `subject` was found empty for `month` and that answer still holds. */
  has(subject: string, month: string): boolean {
    const key = `${subject}@${month}`;
    const expiry = this.expiries.get(key);
    if (expiry === undefined) return false;
    if (expiry > Date.now()) return true;
    this.expiries.delete(key);
    return false;
  }

  /** Record that `subject` came back empty for `month`. */
  remember(subject: string, month: string): void {
    if (this.expiries.size >= this.max) this.evict();
    this.expiries.set(`${subject}@${month}`, Date.now() + this.ttlMs);
  }

  /**
   * Forget every remembered window of each subject `matches` accepts, so the
   * next question about it asks the provider again. For a change that makes
   * an earlier "nothing there" untrue (a coin given a new price symbol).
   */
  forgetSubjects(matches: (subject: string) => boolean): void {
    for (const key of [...this.expiries.keys()]) {
      if (matches(key.slice(0, key.lastIndexOf("@")))) {
        this.expiries.delete(key);
      }
    }
  }

  private evict(): void {
    const now = Date.now();
    for (const [key, expiry] of this.expiries) {
      if (expiry <= now) this.expiries.delete(key);
    }
    // Still full of live entries: drop the oldest insertions rather than let
    // the map grow without bound. A dropped entry costs one extra fetch.
    while (this.expiries.size >= this.max) {
      const oldest = this.expiries.keys().next();
      if (oldest.done) break;
      this.expiries.delete(oldest.value);
    }
  }
}
