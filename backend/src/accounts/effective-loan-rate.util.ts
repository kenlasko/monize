/**
 * The annual rate a loan actually carries on a given date.
 *
 * A rate change recorded through the rate-history UI deliberately does NOT
 * write `accounts.interest_rate` -- that column stays user-owned, settable only
 * from the account edit form (`LoanRateChangesService.create` says so in its
 * own doc). So the scalar holds the OLD terms after any recorded
 * change, and anything pricing money at it prices at a rate nobody pays.
 *
 * That is how the scheduled loan bill and the amortization report came to
 * disagree even after they were taught to price the same balance (issue #1253,
 * INV-LOAN-006): the report resolved its rate from the timeline while the bill
 * read the stale scalar. Both now resolve through this rule.
 *
 * The rule, matching `resolveEffectiveLoanTerms` in
 * `frontend/src/lib/loan-comparison.ts` exactly: the latest row effective on or
 * before the date, else the account's own scalar. Rows dated after the date are
 * recorded but not yet in effect -- they belong to later installments.
 *
 * `loan-rate-timeline-cases.json` beside this file is the shared truth table,
 * asserted by this layer's spec AND by the frontend's contract test, because
 * the two layers cannot import each other and a rule copied in prose drifts.
 */

/** The fields of a rate-change row this rule reads. */
export interface EffectiveRateRow {
  /** YYYY-MM-DD. Compared as text, which is why the format is fixed. */
  effectiveDate: string;
  annualRate: number | string;
}

export function effectiveAnnualRateOn(
  rows: readonly EffectiveRateRow[],
  asOfDate: string,
  fallbackAnnualRate: number | null,
): number | null {
  let latest: EffectiveRateRow | null = null;
  for (const row of rows) {
    if (row.effectiveDate > asOfDate) continue;
    // Ties go to the row read last, matching the frontend's stable sort over
    // an ascending-ordered set.
    if (latest === null || row.effectiveDate >= latest.effectiveDate) {
      latest = row;
    }
  }
  // `??`, not `||`: a recorded 0% is a rate, and an absent one has to stay
  // absent rather than becoming a measured zero.
  if (latest === null) return fallbackAnnualRate ?? null;
  const resolved = Number(latest.annualRate);
  return Number.isFinite(resolved) ? resolved : (fallbackAnnualRate ?? null);
}
