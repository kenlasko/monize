/**
 * The bulk-loaded form of the exchange-rate history: every stored observation a
 * reported window can need, indexed by pair, so a chart of 400 points resolves
 * its rates from one query instead of 400.
 *
 * The *policy* -- which observation applies to a date, how old it may be, which
 * direction wins -- is not here. It is `fx-rate-resolver.ts`, the one door every
 * surface asks. This module's only job is to load enough rows that the door can
 * give the same answer for a date whatever window the caller happened to
 * request, and to hand them over in the shape the door reads.
 *
 * What "enough rows" means: for any date `d` inside the window, the answer is
 * the newest observation in `[d - FX_MAX_RATE_AGE_DAYS, d]`. Those dated on or
 * after the window's start are loaded wholesale; of those before it, only the
 * single newest one can ever be chosen, and anything older than the age bound
 * measured from the start is older than the bound measured from any `d` in the
 * window too. So the in-window rows plus one preceding row per pair are exactly
 * sufficient -- which is why a fixed day margin (this file used to load 90 days
 * back and 31 days *ahead*) was the wrong shape: it made a point's rate depend
 * on how wide the chart was, and the forward margin let a date be priced by an
 * observation from its future (issue #1390).
 */
import { todayYMD } from "../date-utils";
import {
  FX_MAX_RATE_AGE_DAYS,
  FxRateResolution,
  describeFxGap,
  resolveFxRate,
} from "./fx-rate-resolver";

/** `"USD->CAD"` -> the stored rates for that pair, ascending by date. */
export type RateIndex = Map<string, Array<{ date: string; rate: number }>>;

/** One `exchange_rates` row, as the query below returns it. */
export interface RateIndexRow {
  from_currency: string;
  to_currency: string;
  rate: string | number;
  rate_date: string | Date | null;
}

/** Runs one parameterized statement; supplied by the caller's scoped door. */
export type RateIndexQuery = (
  sql: string,
  params: unknown[],
) => Promise<RateIndexRow[]>;

/** Only `warn` is used; `Logger` and `console` both satisfy it. */
export interface RateIndexLogger {
  warn(message: string): void;
}

/**
 * Every stored rate between the reporting currency and each of `currencies`, in
 * either direction, that any date in `[startDate, endDate]` could be priced by.
 *
 * Both directions are loaded because the resolver takes the more recent
 * admissible observation whichever way it is stored; dropping one direction
 * here would make half the pairs resolve from a staler row than the history
 * actually holds.
 *
 * The lower anchor is `LEAST(startDate, today)` because a window that opens in
 * the future is priced at today's rate (the resolver clamps a future date), and
 * the preceding-observation branch has to be anchored where the lookups will
 * actually land.
 *
 * `conversionHorizon` is the latest date the caller will actually *convert* at,
 * when that is later than the window it asked for. A monthly series requested to
 * 2024-06-15 prices its June point at the month end, 2024-06-30: loading only to
 * the requested end left the newest admissible observation out of the index, so
 * the June figure changed when the same chart was asked for a wider range --
 * exactly the "a date's rate depends on the window around it" defect this module
 * exists to prevent. Every caller states its horizon rather than the loader
 * widening the window on a guess; omitted, the horizon is the window's end.
 */
export async function buildRateIndex(
  query: RateIndexQuery,
  currencies: Set<string>,
  defaultCurrency: string,
  startDate: string,
  endDate: string,
  conversionHorizon?: string,
): Promise<RateIndex> {
  if (currencies.size === 0) return new Map();

  const loadTo =
    conversionHorizon && conversionHorizon > endDate
      ? conversionHorizon
      : endDate;
  const currArr = Array.from(currencies);
  const rates = await query(
    `WITH pairs AS (
         SELECT c AS from_currency, $2::TEXT AS to_currency
           FROM unnest($1::TEXT[]) AS c
         UNION
         SELECT $2::TEXT AS from_currency, c AS to_currency
           FROM unnest($1::TEXT[]) AS c
       ),
       anchor AS (SELECT LEAST($3::DATE, $5::DATE) AS d)
       SELECT from_currency, to_currency, rate, rate_date
         FROM (
           SELECT er.from_currency, er.to_currency, er.rate, er.rate_date
             FROM exchange_rates er
             JOIN pairs p
               ON er.from_currency = p.from_currency
              AND er.to_currency = p.to_currency
            WHERE er.rate_date >= (SELECT d FROM anchor)
              AND er.rate_date <= GREATEST($4::DATE, (SELECT d FROM anchor))
           UNION
           SELECT pre.from_currency, pre.to_currency, pre.rate, pre.rate_date
             FROM pairs p
             CROSS JOIN LATERAL (
               SELECT er.from_currency, er.to_currency, er.rate, er.rate_date
                 FROM exchange_rates er
                WHERE er.from_currency = p.from_currency
                  AND er.to_currency = p.to_currency
                  AND er.rate_date < (SELECT d FROM anchor)
                  AND er.rate_date >= ((SELECT d FROM anchor) - INTERVAL '${FX_MAX_RATE_AGE_DAYS} days')
                ORDER BY er.rate_date DESC
                LIMIT 1
             ) pre
         ) loaded
        ORDER BY rate_date`,
    // The user's day (todayYMD), not the database server's CURRENT_DATE (#2365).
    [currArr, defaultCurrency, startDate, loadTo, todayYMD()],
  );

  return indexRateRows(rates);
}

/** Group already-fetched rows into the pair index, preserving their order. */
export function indexRateRows(rows: RateIndexRow[]): RateIndex {
  const index: RateIndex = new Map();
  for (const r of rows) {
    const key = `${r.from_currency}->${r.to_currency}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key)!.push({
      date: rateDateString(r.rate_date),
      rate: Number(r.rate),
    });
  }
  return index;
}

/**
 * Pairs already warned about, keyed by the per-request index object, so each
 * pair warns once per computation instead of once per chart point.
 */
const gapWarned = new WeakMap<RateIndex, Set<string>>();

function warnOnce(
  rateIndex: RateIndex,
  pair: string,
  message: string,
  logger?: RateIndexLogger,
): void {
  if (!logger) return;
  let seen = gapWarned.get(rateIndex);
  if (!seen) {
    seen = new Set();
    gapWarned.set(rateIndex, seen);
  }
  if (seen.has(pair)) return;
  seen.add(pair);
  logger.warn(message);
}

/**
 * Resolutions already made against an index, keyed by the index object and
 * then by `"FROM->TO@date"`.
 *
 * A daily valuation asks the same question once per HOLDING per day: sixty
 * positions in two foreign currencies resolve each pair sixty times for one
 * date, and every resolution pays for its own date arithmetic. Over a
 * twenty-eight-year history that was most of a three-second fold, run once per
 * concurrent request on the Investments page (issue #1888). The answer for a
 * (pair, date) cannot change while the index lives -- an index is built once
 * and never patched; a fill re-reads into a new one -- so it is remembered for
 * the index's lifetime and dropped with it.
 */
const resolutionMemo = new WeakMap<RateIndex, Map<string, FxRateResolution>>();

/**
 * The rate for `from -> to` on `onDate`, resolved from a loaded index.
 *
 * The whole resolution, not just the number: `observedOn` says which day's
 * observation was used and `reason` says why there is none, which is what a
 * surface needs to explain a withheld figure rather than showing a bare gap.
 * Treat the returned object as read-only: it is shared by every lookup of the
 * same pair and date against the same index.
 */
export function resolveIndexedRate(
  rateIndex: RateIndex,
  from: string,
  to: string,
  onDate: string,
): FxRateResolution {
  let memo = resolutionMemo.get(rateIndex);
  if (!memo) {
    memo = new Map();
    resolutionMemo.set(rateIndex, memo);
  }
  const key = `${from}->${to}@${onDate}`;
  const known = memo.get(key);
  if (known) return known;
  const resolution = resolveFxRate(from, to, onDate, (f, t) =>
    rateIndex.get(`${f}->${t}`),
  );
  memo.set(key, resolution);
  return resolution;
}

/**
 * Date-aware conversion into the reporting currency. Returns `null` when no
 * admissible rate exists for the pair, in either direction, for `onOrBefore`.
 *
 * `null`, not the amount unchanged: the predecessor of this function ended in
 * `result ?? amount`, which reported 1,000 USD as 1,000 EUR and left a consumer
 * unable to tell that from a genuine 1:1 pair (audit P5-009). And `null`, not
 * the earliest stored rate: valuing last March at a rate first observed this
 * June is look-ahead, which `docs/time-series-contract.md` forbids and which
 * `docs/specs/fx-conversion-completeness.md` section 6 now settles as removed.
 */
export function convertAtDate(
  amount: number,
  from: string,
  to: string,
  onOrBefore: string,
  rateIndex: RateIndex,
  logger?: RateIndexLogger,
): number | null {
  // Zero converts to zero at any rate, so it needs none (and records no gap):
  // an emptied account in a currency with no stored rates is a settled zero,
  // not an unknowable value, and flagging it incomplete would report a question
  // that was never open as one that could not be answered.
  if (amount === 0) return 0;

  // The direct/inverse decision, the age bound and the no-look-ahead rule are
  // all the resolver's; this function only multiplies.
  const resolution = resolveIndexedRate(rateIndex, from, to, onOrBefore);
  if (resolution.rate === null) {
    const pair = `${from}->${to}`;
    warnOnce(
      rateIndex,
      pair,
      describeFxGap(pair, onOrBefore, resolution.reason ?? "no_observation"),
      logger,
    );
    return null;
  }
  return amount * resolution.rate;
}

/**
 * A DATE column as `YYYY-MM-DD`, whether the driver handed back text or a Date.
 *
 * A row with no date at all falls back to today, which is what the net-worth
 * service's own `toDateString` did before this extraction and what its fixtures
 * rely on. `exchange_rates.rate_date` is `NOT NULL`, so the branch is reachable
 * only from a hand-built row.
 */
function rateDateString(value: string | Date | null | undefined): string {
  if (!value) return new Date().toISOString().substring(0, 10);
  if (typeof value === "string") return value.substring(0, 10);
  return value.toISOString().substring(0, 10);
}
