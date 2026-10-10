import { getDecimalPlacesForCurrency, roundMoney, roundToDecimals, sumMoney } from '@/lib/format';

/**
 * Book a split set in a currency's smallest unit (issue #1581): the parent and
 * every line rounded to `decimals`, and the difference the line roundings
 * leave on the line at `absorbIndex`, so the lines sum to the parent exactly.
 * Only a rounding difference is moved: lines that did not already sum to the
 * parent at 4dp are only rounded, and the split editor shows the gap.
 *
 * Mirrors `bookSplitsAtMinorUnit` in
 * `backend/src/common/currency-minor-unit.util.ts`, which books the same
 * stored template to recognise an unchanged Post dialog; both suites run
 * `backend/src/common/minor-unit-booking-cases.json`.
 */
export function bookSplitsAtMinorUnit(
  amounts: readonly number[],
  parentAmount: number,
  decimals: number,
  absorbIndex: number,
): { amounts: number[]; parentAmount: number } {
  const parent = roundToDecimals(Number(parentAmount), decimals);
  const rounded = amounts.map((amount) => roundToDecimals(Number(amount), decimals));
  const balanced = sumMoney(amounts.map(Number)) === roundMoney(Number(parentAmount));
  if (!balanced || absorbIndex < 0 || absorbIndex >= rounded.length) {
    return { amounts: rounded, parentAmount: parent };
  }
  const residual = roundMoney(parent - sumMoney(rounded));
  return {
    amounts: rounded.map((amount, index) =>
      index === absorbIndex ? roundMoney(amount + residual) : amount,
    ),
    parentAmount: parent,
  };
}

/** The server's `LOAN_LIKE_ACCOUNT_TYPES`; the parity fixture holds the two together. */
export const LOAN_LIKE_ACCOUNT_TYPES: ReadonlySet<string> = new Set(['LOAN', 'MORTGAGE', 'LINE_OF_CREDIT']);

interface BookableLine {
  amount: number;
  transferAccountId?: string | null;
  memo?: string | null;
}

/**
 * Which line takes the rounding difference when a split set is booked in the
 * currency's unit: on a loan payment the principal line (the first line
 * transferring to a loan-like account whose memo does not name it the extra
 * principal), otherwise the largest line. Mirrors the server's
 * `minorUnitAbsorbIndex`.
 */
export function minorUnitAbsorbIndex(
  lines: readonly BookableLine[],
  accountTypeById: ReadonlyMap<string, string>,
): number {
  const loanAccountId = lines
    .map((line) => line.transferAccountId)
    .find((id) => !!id && LOAN_LIKE_ACCOUNT_TYPES.has(accountTypeById.get(id) ?? ''));
  if (loanAccountId) {
    const principalIndex = lines.findIndex(
      (line) =>
        line.transferAccountId === loanAccountId &&
        !(line.memo ?? '').toLowerCase().includes('extra'),
    );
    if (principalIndex >= 0) return principalIndex;
  }
  return lines.reduce(
    (best, line, index) =>
      Math.abs(Number(line.amount)) > Math.abs(Number(lines[best].amount)) ? index : best,
    0,
  );
}

/**
 * Pre-fill a scheduled transaction's split rows booked in its currency's
 * smallest unit, with the parent they belong under. Every surface that loads
 * a template into a form (the Post dialog, the occurrence override editor,
 * the template form) goes through this: rounding the parent and leaving the
 * 4dp lines under it is what the server refused in issue #1581.
 *
 * `templateSplits` are the schedule's stored splits, which carry their
 * transfer account and so say which line pays a loan. Null when there is
 * nothing to book: no rows, or an investment line, whose amount is its
 * trade's cash impact.
 */
export function bookSplitRowsAtMinorUnit<T extends BookableLine & { splitType: string }>(
  rows: readonly T[],
  parentAmount: number,
  currencyCode: string | null | undefined,
  templateSplits:
    | readonly { transferAccountId: string | null; transferAccount?: { accountType: string } | null }[]
    | null
    | undefined,
): { rows: T[]; parentAmount: number } | null {
  if (rows.length === 0 || rows.some((row) => row.splitType === 'investment')) return null;
  const accountTypeById = new Map<string, string>();
  for (const split of templateSplits ?? []) {
    if (split.transferAccountId && split.transferAccount) {
      accountTypeById.set(split.transferAccountId, split.transferAccount.accountType);
    }
  }
  const booked = bookSplitsAtMinorUnit(
    rows.map((row) => row.amount),
    parentAmount,
    currencyCode ? getDecimalPlacesForCurrency(currencyCode) : 2,
    minorUnitAbsorbIndex(rows, accountTypeById),
  );
  return {
    rows: rows.map((row, index) => ({ ...row, amount: booked.amounts[index] })),
    parentAmount: booked.parentAmount,
  };
}
