import type {
  ScheduleAmountEstimate,
  ScheduledTransaction,
  ScheduledTransactionOverride,
} from '@/types/scheduled-transaction';
import { sumConverted, type ConvertedTotal } from '@/lib/currency-total';
import { moneyDecimalsForCurrency, roundMoney, sumMoney } from '@/lib/format';

/**
 * The cash amount one scheduled occurrence would post today, and whether that is
 * known.
 *
 * `amount` is `null` exactly when the server could not determine it -- today,
 * when the current settlement exchange rate for an FX-sensitive schedule cannot
 * be resolved. `null` is never a licence to read the persisted
 * `ScheduledTransaction.amount`: that scalar was computed at whatever rate was
 * current when it was written, and presenting it as the current amount is the
 * defect this module exists to prevent (issue #1247).
 */
export interface EffectiveScheduledAmount {
  amount: number | null;
  currencyCode: string;
  /** `amount !== null`. A total containing an incomplete item is incomplete. */
  complete: boolean;
  /**
   * The signed amount that decides direction, `null` when it is not derivable,
   * and `undefined` when the server did not say (an older backend mid rolling
   * deploy, which is no information rather than a licence to guess).
   */
  directionAmount?: number | null;
}

/**
 * A schedule whose cash total is re-priced by the current FX rate: a top-level
 * investment schedule (its stored `amount` is the security-currency cash impact,
 * converted at the settlement rate) or a split parent carrying an investment
 * line (each line settles its own security's currency).
 *
 * Only used for the rolling-deploy fallback below -- a current backend answers
 * with `effectiveAmount` and this predicate is not consulted.
 */
function isFxSensitive(st: ScheduledTransaction): boolean {
  return (
    st.isInvestment === true ||
    (st.isSplit === true &&
      (st.splits?.some(
        s => s.investmentAction != null || s.kind === 'investment',
      ) ??
        false))
  );
}

/**
 * The amount every un-overridden occurrence of `st` would post today.
 *
 * Reads the server's `effectiveAmount` whenever the field is present -- `null`
 * included, which means "unknown", not "absent". An **absent** field is an older
 * backend mid rolling deploy, which is no information rather than a blessing of
 * the stored scalar: a schedule the current rate re-prices is reported unknown,
 * and one no rate touches keeps its stored amount (the same split
 * `lib/forecast.ts` makes for the cash-flow projection).
 */
export function scheduleEffectiveAmount(
  st: ScheduledTransaction,
): EffectiveScheduledAmount {
  const currencyCode = st.effectiveCurrencyCode ?? st.currencyCode;
  if (st.effectiveAmount !== undefined) {
    return {
      amount: st.effectiveAmount,
      currencyCode,
      complete: st.effectiveAmount !== null,
      directionAmount: st.effectiveDirectionAmount,
    };
  }
  if (isFxSensitive(st)) {
    return { amount: null, currencyCode, complete: false };
  }
  return { amount: Number(st.amount), currencyCode, complete: true };
}

/**
 * The amount the occurrence governed by `override` would post today, with the
 * same override-then-base precedence the posting applies: an override that
 * carries no amount of its own falls through to the base occurrence and inherits
 * its completeness.
 */
export function overrideEffectiveAmount(
  st: ScheduledTransaction,
  override: ScheduledTransactionOverride,
): EffectiveScheduledAmount {
  const base = scheduleEffectiveAmount(st);
  if (override.effectiveAmount !== undefined) {
    return {
      amount: override.effectiveAmount,
      currencyCode: base.currencyCode,
      complete: override.effectiveAmount !== null,
      directionAmount: override.effectiveDirectionAmount,
    };
  }
  // Older backend. An FX-sensitive schedule's override is re-priced the same way
  // its base is, so its stored scalar says nothing about today either.
  if (isFxSensitive(st)) {
    return { amount: null, currencyCode: base.currencyCode, complete: false };
  }
  if (override.amount != null) {
    return {
      amount: Number(override.amount),
      currencyCode: base.currencyCode,
      complete: true,
    };
  }
  return base;
}

/**
 * The amount the schedule's *next* occurrence would post today -- the one figure
 * a surface listing "what is coming up" should show. Honours the per-occurrence
 * override on that date when the server sent one.
 */
export function nextOccurrenceEffectiveAmount(
  st: ScheduledTransaction,
): EffectiveScheduledAmount {
  return st.nextOverride
    ? overrideEffectiveAmount(st, st.nextOverride)
    : scheduleEffectiveAmount(st);
}

/**
 * Whether an occurrence governed by `override` (or by none) is priced from the
 * schedule's history estimate (issue #2096, docs/specs/scheduled-amount-estimate.md
 * section 6): an override that states an amount, or carries its own split
 * lines, is that occurrence's amount; any other follows the estimate.
 */
export function occurrenceFollowsEstimate(
  st: ScheduledTransaction,
  override?: Pick<ScheduledTransactionOverride, 'amount' | 'isSplit'> | null,
): boolean {
  if (st.amountIsEstimated !== true) return false;
  if (!override) return true;
  return override.amount == null && override.isSplit !== true;
}

/**
 * The history estimate for an occurrence of `st` falling on `dueDate`
 * (`YYYY-MM-DD`): `undefined` when `st` is not estimated, so the caller prices
 * it as it always has; `null` when the estimate is unknown for that month (no
 * history, no rate, a month beyond what the server sent), which is rendered as
 * unknown and never replaced by `st.amount`; the amount otherwise.
 *
 * The one reader of `amountEstimate`: the forecast, the Post dialog, the
 * occurrence editor and the occurrence picker all ask here.
 */
export function estimatedOccurrenceAmount(
  st: ScheduledTransaction,
  dueDate: string,
): number | null | undefined {
  if (st.amountIsEstimated !== true) return undefined;
  return estimateAmountOn(st.amountEstimate, dueDate);
}

/**
 * The amount `estimate` gives an occurrence falling on `dueDate`, or `null`
 * when it gives none (an unknown estimate, a month it does not hold, or no
 * estimate read yet). For a form previewing a schedule not saved yet; a saved
 * row is read through `estimatedOccurrenceAmount`.
 */
export function estimateAmountOn(
  estimate: ScheduleAmountEstimate | null | undefined,
  dueDate: string,
): number | null {
  const entry = estimate?.months[String(dueDate).slice(0, 7)];
  return entry ? entry.amount : null;
}

/**
 * An estimated schedule's typical occurrence: the mean of its estimate over the
 * twelve months from `fromYmd`'s, for a figure that stands for the bill rather
 * than for one season (the Bills page's monthly totals). `undefined` when `st`
 * is not estimated, `null` when any of those months is unknown.
 */
export function estimatedTypicalAmount(
  st: ScheduledTransaction,
  fromYmd: string,
): number | null | undefined {
  if (st.amountIsEstimated !== true) return undefined;
  const [year, month] = fromYmd.split('-').map(Number);
  const amounts: number[] = [];
  for (let i = 0; i < 12; i++) {
    const index = year * 12 + (month - 1) + i;
    const key = `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
    const entry = st.amountEstimate?.months[key];
    if (!entry) return null;
    amounts.push(entry.amount);
  }
  const decimals = moneyDecimalsForCurrency(st.currencyCode);
  return roundMoney(sumMoney(amounts, decimals) / amounts.length, decimals);
}

/**
 * The account whose balance one occurrence of `st` actually moves.
 *
 * The amount is half the answer; the account is the other half. A scheduled
 * investment's `accountId` is the BROKERAGE, but its cash settles in the named
 * funding account or the brokerage's linked cash account -- so a running balance
 * keyed on `accountId` charges the brokerage for cash it never moves, and the
 * account that pays is left projecting an outflow it never sees. That is how the
 * dashboard's below-zero warning fired on a purchase whose funding account covers
 * it to the cent: the brokerage's own balance is not the cash the trade spends
 * (issue #1247, INV-OCCURRENCE-003).
 *
 * The server's `settlementAccountId` is authoritative -- it is the same decision
 * `resolveSettlementAccountId` makes for the posting, so a projection cannot
 * charge a different account than the posting will. When the field is absent (an
 * older backend mid rolling deploy) the answer is derived from the funding and
 * linked accounts the client already holds, exactly as the cash-flow forecast has
 * always derived it.
 *
 * `undefined` means "this investment schedule's settlement account cannot be
 * identified from what the client holds" -- a caller projects nothing rather than
 * falling back to `accountId`, which is the defect above. A non-investment
 * schedule always settles in its own account.
 */
export function occurrenceSettlementAccountId(
  st: ScheduledTransaction,
  accountsById: ReadonlyMap<string, { linkedAccountId?: string | null }>,
): string | undefined {
  if (st.settlementAccountId) return st.settlementAccountId;
  if (!st.isInvestment) return st.accountId;
  if (st.investmentFundingAccountId) return st.investmentFundingAccountId;
  return accountsById.get(st.accountId)?.linkedAccountId ?? undefined;
}

/**
 * The accounts one occurrence's money moves through: the account it settles in,
 * and the counterparty of a transfer.
 *
 * The settlement account is `occurrenceSettlementAccountId`, never the
 * occurrence's own `accountId`. For a scheduled investment those two differ:
 * `accountId` is the brokerage, and the cash leaves the funding account or the
 * brokerage's linked cash account. A calendar filtered to a chequing account
 * that read `accountId` would leave out a purchase draining it, and would draw
 * that purchase on a brokerage whose cash never moves (INV-OCCURRENCE-003).
 *
 * An investment schedule whose settlement account cannot be identified from
 * what the client holds touches no account this function can name, so it is in
 * no scope -- rather than being charged to the brokerage, which is the defect
 * above wearing a fallback.
 */
export function occurrenceAccountIds(
  occurrence: { transferAccountId: string | null },
  schedule: ScheduledTransaction,
  accountsById: ReadonlyMap<string, { linkedAccountId?: string | null }>,
): string[] {
  const settlement = occurrenceSettlementAccountId(schedule, accountsById);
  const ids: string[] = [];
  if (settlement) ids.push(settlement);
  if (occurrence.transferAccountId) ids.push(occurrence.transferAccountId);
  return ids;
}

/** Whether any account this occurrence moves money through is in `scope`. */
export function occurrenceTouchesAccounts(
  occurrence: { transferAccountId: string | null },
  schedule: ScheduledTransaction,
  accountsById: ReadonlyMap<string, { linkedAccountId?: string | null }>,
  scope: ReadonlySet<string>,
): boolean {
  return occurrenceAccountIds(occurrence, schedule, accountsById).some((id) =>
    scope.has(id),
  );
}

/**
 * The date the schedule's *next* occurrence actually falls on.
 *
 * `nextDueDate` is the recurrence slot; an override addressed to that slot can
 * move the occurrence, and the moved date is when the money moves. A surface
 * that filters, sorts or prints the slot instead announces a payment on a day
 * the user has already changed -- the same defect as reading the persisted
 * amount, applied to the date (issue #1247).
 */
export function nextOccurrenceDueDate(st: ScheduledTransaction): string {
  return st.nextOverride?.overrideDate
    ? String(st.nextOverride.overrideDate).split('T')[0]
    : String(st.nextDueDate).split('T')[0];
}

/**
 * The occurrence a person is looking at, as the server's Post and Skip routes
 * take it: the date shown (the override's, else the slot -- `nextOccurrenceDueDate`)
 * and the id of the override that moved it, `null` when there is none. The server
 * refuses with 409 once that is no longer the occurrence it would act on, so a
 * stale tab cannot post the next occurrence early or pay an exhausted schedule
 * again (audit A26-S08-01). Build it from the row as the user saw it, never from a
 * re-read, and never from `nextDueDate` or `amount` directly.
 */
export function occurrencePin(st: ScheduledTransaction): {
  expectedOccurrenceDate: string;
  expectedOverrideId: string | null;
} {
  return {
    expectedOccurrenceDate: nextOccurrenceDueDate(st),
    expectedOverrideId: st.nextOverride?.id ?? null,
  };
}

/**
 * Convert and total a bucket of effective occurrence amounts into one currency.
 *
 * This exists instead of a currency-blind adder. The predecessor took the same
 * `EffectiveScheduledAmount` accessor and read only its `amount`, so it summed a
 * 1,350 CAD occurrence beside a 500 USD one and handed back 1,850 for a caller
 * to format in the reader's default currency -- a 23% overstatement presented as
 * a real figure. Passing the right `currencyCode` into it fixed nothing, because
 * it never looked. `sumConverted` cannot be called without saying how to convert.
 *
 * `convert` returns `null` for a pair with no rate, which keeps the total
 * withheld and names the currency; an occurrence whose own amount is unknown
 * arrives as `NaN` and is excluded by count, because it is unknown in every
 * currency and has no pair to blame. `map` applies the bucket's convention
 * (bills as positive magnitudes) *after* conversion. Check `isComplete` before
 * displaying the value: a caller either withholds an incomplete total or marks
 * it with `PartialTotal`, and never prints it under a total's own caption.
 */
export function sumEffectiveOccurrences<T>(
  items: readonly T[],
  effective: (item: T) => EffectiveScheduledAmount,
  convert: (amount: number, fromCurrency: string) => number | null,
  map: (amount: number) => number = amount => amount,
): ConvertedTotal {
  return sumConverted(
    items,
    item => effective(item).amount ?? NaN,
    item => effective(item).currencyCode,
    (amount, currency) => {
      const converted = convert(amount, currency);
      return converted === null ? null : map(converted);
    },
  );
}
