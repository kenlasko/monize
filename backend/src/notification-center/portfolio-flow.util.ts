import { FIAT_MONEY_DECIMALS, moneyUnits } from "../common/round.util";

/** One currency's external-flow subtotal, in that currency. */
export interface FlowSubtotal {
  /**
   * The day the flow landed on, when the caller subtotalled per day
   * (`loadExternalFlowSubtotals({ perDay: true })`); `null`/absent when the
   * subtotal is over a whole window and so has no single date to price at.
   */
  date?: string | null;
  currency: string;
  amount: number;
}

/** The external flow converted into the reporting currency, with completeness. */
export interface FoldedFlow {
  /** False when any subtotal could not be converted (a missing rate). */
  complete: boolean;
  /** The net external flow in the reporting currency (0 when complete and empty). */
  value: number;
  /**
   * `"EUR->USD"` for each pair with no rate, or `"EUR->USD on 2026-09-12"` when
   * the subtotal was dated and it is that day's rate that is missing. Empty when
   * complete; this is what names the cause of a withheld movement.
   */
  missingPairs: string[];
}

/** Money is decimal(20,4), so a fold accumulates in units of 1/10000. */
const MONEY_UNITS = 10_000;

/**
 * Fold the per-currency external-flow subtotals into one figure in the reporting
 * currency. A subtotal with no rate makes the whole flow **incomplete** (the
 * movement is then unknown and withheld, INV-PORTMOVE-002) rather than dropping
 * that currency and reporting a subtotal as a total.
 *
 * `rateFor` returns the rate from a currency into the reporting currency **on
 * the subtotal's own date**, or `null` when none is known (and 1 for the
 * reporting currency itself). The date is passed rather than assumed, because a
 * deposit that landed on Saturday is worth Saturday's rate, not the rate of the
 * day the cron happens to run: pricing a whole window's flow at one closing rate
 * invents a movement out of the FX move between the two dates (INV-PORTMOVE-007).
 * A caller with an undated window subtotal receives `null` and decides for
 * itself.
 *
 * Amounts accumulate as integer 1/10000 units and are divided once, so a fold
 * over many days does not drift the way repeated float addition does.
 *
 * Pure so the completeness policy is testable without the rate service or a
 * database.
 */
export function foldExternalFlow(
  subtotals: FlowSubtotal[],
  reportingCurrency: string,
  rateFor: (currency: string, date: string | null) => number | null,
): FoldedFlow {
  const missingPairs: string[] = [];
  let units = 0;
  for (const { currency, amount, date } of subtotals) {
    if (amount === 0) continue;
    const on = date ?? null;
    const rate = currency === reportingCurrency ? 1 : rateFor(currency, on);
    if (rate === null || !(rate > 0)) {
      const pair = `${currency}->${reportingCurrency}`;
      const label = on === null ? pair : `${pair} on ${on}`;
      if (!missingPairs.includes(label)) missingPairs.push(label);
      continue;
    }
    units += moneyUnits(amount * rate, FIAT_MONEY_DECIMALS);
  }
  return {
    complete: missingPairs.length === 0,
    value: units / MONEY_UNITS,
    missingPairs,
  };
}
