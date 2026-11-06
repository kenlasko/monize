import {
  FIAT_MONEY_DECIMALS,
  roundMoney,
  roundToDecimals,
  sumMoney,
} from "./round.util";
import { AccountType } from "../accounts/entities/account.entity";

/**
 * The number of decimals a currency's smallest unit has: 2 for EUR (cents),
 * 0 for JPY. What money a bank actually moves is booked at.
 *
 * Read from `Intl` exactly as the client's `getDecimalPlacesForCurrency`
 * (`frontend/src/lib/format.ts`) reads it, so a figure the Post dialog shows
 * and the figure the server books round to the same unit. An unknown or
 * missing code falls back to 2, as the client does.
 */
export function currencyMinorUnitDecimals(
  currencyCode: string | null | undefined,
): number {
  if (!currencyCode) return 2;
  try {
    return (
      new Intl.NumberFormat("en", {
        style: "currency",
        currency: currencyCode,
      }).resolvedOptions().minimumFractionDigits ?? 2
    );
  } catch {
    return 2;
  }
}

/**
 * Book a split set in a currency's smallest unit (issue #1581).
 *
 * Amounts are priced at storage precision (4dp): a LINEAR mortgage's
 * installment is 864.5833 + 306.0625 = 1,170.6458. The bank debits whole
 * cents, so the posted transaction carries the parent rounded to the unit
 * (1,170.65), every line rounded to the unit, and the difference the line
 * roundings leave (here +0.01) on the line at `absorbIndex` (864.59), so the
 * lines sum to the parent exactly and the split validator's 4dp equality
 * holds.
 *
 * Only a rounding difference is moved: when the lines did not already sum to
 * the parent at 4dp (an occurrence override that changed the amount and not
 * the lines), the gap is not this function's to place, so the lines are only
 * rounded and the split editor shows the imbalance for the user to settle.
 *
 * Mirrored by `bookSplitsAtMinorUnit` in `frontend/src/lib/minor-unit-booking.ts`;
 * both suites run `minor-unit-booking-cases.json`, because the server
 * recognises an unchanged Post dialog by comparing what it sent with this
 * function's answer for the stored template.
 *
 * The balance test and the residual are at `FIAT_MONEY_DECIMALS`: every caller
 * books a loan, mortgage or line-of-credit payment, and those accounts are fiat
 * by construction (INV-CRYPTO-001), so the storage precision here is four.
 */
export function bookSplitsAtMinorUnit(
  amounts: readonly number[],
  parentAmount: number,
  decimals: number,
  absorbIndex: number,
): { amounts: number[]; parentAmount: number } {
  const parent = roundToDecimals(Number(parentAmount), decimals);
  const rounded = amounts.map((amount) =>
    roundToDecimals(Number(amount), decimals),
  );
  const balanced =
    sumMoney(amounts.map(Number), FIAT_MONEY_DECIMALS) ===
    roundMoney(Number(parentAmount), FIAT_MONEY_DECIMALS);
  if (!balanced || absorbIndex < 0 || absorbIndex >= rounded.length) {
    return { amounts: rounded, parentAmount: parent };
  }
  const residual = roundMoney(
    parent - sumMoney(rounded, FIAT_MONEY_DECIMALS),
    FIAT_MONEY_DECIMALS,
  );
  return {
    amounts: rounded.map((amount, index) =>
      index === absorbIndex
        ? roundMoney(amount + residual, FIAT_MONEY_DECIMALS)
        : amount,
    ),
    parentAmount: parent,
  };
}

/**
 * The account types a scheduled loan payment amortizes against. The loan
 * recalculation (`ScheduledTransactionLoanService`) and the booking below both
 * read this one list; the client's copy is held to it by
 * `minor-unit-booking-cases.json`.
 */
export const LOAN_LIKE_ACCOUNT_TYPES: ReadonlySet<string> = new Set<string>([
  AccountType.LOAN,
  AccountType.MORTGAGE,
  AccountType.LINE_OF_CREDIT,
]);

interface BookableLine {
  amount: number | string;
  transferAccountId?: string | null;
  memo?: string | null;
}

/**
 * Which line takes the rounding difference when a split set is booked in the
 * currency's unit.
 *
 * On a loan payment it is the principal line: the first line transferring to
 * a loan-like account whose memo does not name it the extra principal, the
 * line `resolveInstallment` treats as principal. Interest is the period's
 * charge; principal is what retires the loan. Any other split set gives it to
 * its largest line, where a cent moves the least.
 *
 * Mirrored by `minorUnitAbsorbIndex` in `frontend/src/lib/minor-unit-booking.ts`.
 */
export function minorUnitAbsorbIndex(
  lines: readonly BookableLine[],
  accountTypeById: ReadonlyMap<string, string>,
): number {
  const loanAccountId = lines
    .map((line) => line.transferAccountId)
    .find(
      (id) =>
        !!id && LOAN_LIKE_ACCOUNT_TYPES.has(accountTypeById.get(id) ?? ""),
    );
  if (loanAccountId) {
    const principalIndex = lines.findIndex(
      (line) =>
        line.transferAccountId === loanAccountId &&
        !(line.memo ?? "").toLowerCase().includes("extra"),
    );
    if (principalIndex >= 0) return principalIndex;
  }
  return lines.reduce(
    (best, line, index) =>
      Math.abs(Number(line.amount)) > Math.abs(Number(lines[best].amount))
        ? index
        : best,
    0,
  );
}
