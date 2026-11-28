import { FxAggregate } from "./fx-aggregate";
import { resolveFxRateOrNull } from "./fx-entry.util";

/** The rate ladder this module needs; `ExchangeRateService` satisfies it. */
export interface FxRateSource {
  getRateForDate(
    from: string,
    to: string,
    date: string,
  ): Promise<number | null>;
  getLatestRate(from: string, to: string): Promise<number | null>;
}

/** One amount to be folded into a total, with the currency it is expressed in. */
export interface ConvertibleAmount {
  /** `null` when the value itself could not be worked out -- unknown in EVERY currency. */
  amount: number | null;
  currency: string;
}

/** A total, the partial sum behind it, and the pairs that stopped it completing. */
export interface ConvertedTotal {
  /** `null` when any component was left out, by either cause. */
  total: number | null;
  /** What did convert. Never publishable under a field whose name says "total". */
  knownSubtotal: number;
  /** `"CAD->USD"` per unresolvable pair; empty when nothing was missing a rate. */
  missingPairs: string[];
}

/**
 * One rate lookup per currency PAIR for the life of one read, not one per item.
 *
 * Twelve CAD bills in a USD total asked the identical question twelve times, in
 * series, and on a cold pair the first fetches a provider window while the other
 * eleven wait behind it. `asOf` is fixed across a read, so the source currency is
 * the whole key.
 *
 * Exported because a caller that converts more than one bucket into the same
 * currency should share one cache across them.
 */
export function memoizedRateResolver(
  rates: FxRateSource,
  into: string,
  asOf: string,
): (from: string) => Promise<number | null> {
  const cache = new Map<string, Promise<number | null>>();
  return (from: string) => {
    let pending = cache.get(from);
    if (!pending) {
      // Through `resolveFxRateOrNull`, never a raw service call: a stored rate of
      // zero or a negative one is ABSENT, not applicable, and multiplying by it
      // converts a 1,350 bill to nothing under a total that still reports itself
      // complete.
      pending = resolveFxRateOrNull(rates, from, into, asOf);
      cache.set(from, pending);
    }
    return pending;
  };
}

/**
 * Convert every component into `into` and total them, or withhold the total and
 * say why.
 *
 * This is the one place "how does a bucket of per-currency amounts become one
 * total" is decided. It existed twice -- inline in `BudgetsService.getVelocity`
 * and again in `ScheduledTransactionsService.getLlmUpcomingBillsAndDeposits`,
 * comments and all -- and the next change to it (whether a same-currency
 * component still rounds, whether a rejected provider fetch withholds or throws)
 * would have had to be made in both, with only one of them reasoned about.
 *
 * Two causes of an incomplete total, kept apart because they send the reader to
 * different repairs:
 *
 *   * an `amount` of `null` -- the value could not be worked out at all, so it is
 *     unknown in every currency and there is no pair to blame. Counted, never
 *     named: reporting "no rate for CAD->USD" would send the reader to add a rate
 *     that is very likely already there.
 *   * a currency with no rate into `into` -- named in `missingPairs`, because
 *     that one IS a rate the reader can add.
 *
 * `sign` maps each amount into the bucket's own convention (bills are reported as
 * positive magnitudes). It is applied BEFORE conversion, which is equivalent for
 * a positive rate, and the one rounding happens when the total is read.
 */
export async function convertingTotal(
  items: readonly ConvertibleAmount[],
  into: string,
  rateFor: (from: string) => Promise<number | null>,
  sign: (amount: number) => number = (amount) => amount,
): Promise<ConvertedTotal> {
  const agg = new FxAggregate();
  for (const item of items) {
    if (item.amount === null) {
      agg.addUnknown();
      continue;
    }
    const amount = sign(item.amount);
    // Same currency is 1:1 BY DEFINITION, so it needs no rate at all -- asking
    // for one would make an ordinary single-currency total unknowable whenever
    // the rate table happened not to hold a self-pair.
    if (item.currency === into) {
      agg.addConverted(amount);
      continue;
    }
    const rate = await rateFor(item.currency);
    // Unrounded: `FxAggregate` sums at guard digits and rounds once when read, so
    // a per-part rounding here would drift the total by a unit (issue #2360).
    agg.add(rate === null ? null : amount * rate, item.currency, into);
  }
  return {
    total: agg.total,
    knownSubtotal: agg.knownSubtotal,
    missingPairs: agg.missingPairs,
  };
}
