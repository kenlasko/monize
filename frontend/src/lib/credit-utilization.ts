import { Account } from '@/types/account';
import { chartColors } from '@/lib/chart-colors';
import { accountCarriesBalance } from '@/lib/account-carries-balance';

/**
 * Only credit cards and lines of credit with a positive credit limit have a
 * meaningful utilization figure (used / available credit). Shared by the Credit
 * Utilization report and its dashboard widgets.
 *
 * A closed card still owing a balance stays in whatever limit it recorded: the
 * debt is still the user's and still counts in net worth, so leaving it out
 * would understate what is drawn (`accountCarriesBalance`). Its limit is gone,
 * so `effectiveCreditLimit` counts it as zero. A closed card at zero is out,
 * and so is one closed holding a credit (a positive balance is owed to the
 * user, not drawn, so it would otherwise read as fully used).
 */
export const isCreditAccount = (account: Account): boolean =>
  (account.accountType === 'CREDIT_CARD' || account.accountType === 'LINE_OF_CREDIT') &&
  (account.isClosed
    ? accountCarriesBalance(account) && Number(account.currentBalance) < 0
    : account.creditLimit != null && account.creditLimit > 0);

/**
 * The credit an account still offers: its recorded limit while it is open,
 * zero once it is closed. A closed card's balance is still owed, but nothing
 * can be drawn against it, so counting its old limit would inflate available
 * credit and flatter the utilization figure.
 */
export function effectiveCreditLimit(account: Account): number {
  return account.isClosed ? 0 : Number(account.creditLimit) || 0;
}

/**
 * Utilization thresholds drive the colour: low (green), moderate (amber), high
 * (red). 30% / 75% mirror the common "keep utilization under 30%" guidance.
 */
export function utilizationColour(percent: number): string {
  if (percent >= 75) return chartColors.expense;
  if (percent >= 30) return chartColors.warning;
  return chartColors.income;
}

export interface CreditUtilizationRow {
  id: string;
  name: string;
  accountType: Account['accountType'];
  currencyCode: string;
  /**
   * Amounts in the display currency, or `null` when no rate for this account's
   * currency was available. The *percentage* is computed natively and is always
   * known -- utilisation is a ratio within one currency, so it needs no rate.
   */
  limit: number | null;
  used: number | null;
  available: number | null;
  utilizationPercent: number;
}

export interface CreditUtilizationTotals {
  limit: number;
  used: number;
  available: number;
  utilizationPercent: number;
  /**
   * Currencies excluded from the money totals for want of a rate. Non-empty
   * means `limit`, `used` and `available` are subtotals -- and that
   * `utilizationPercent`, being their ratio, describes only the included
   * accounts.
   */
  missingCurrencies: string[];
  /** Number of accounts left out of the totals (a component count, not a currency count). */
  excludedCount: number;
}

/**
 * Per-account utilization rows, all amounts converted into `displayCurrency`.
 * Liability balances are stored negative when money is owed, so the magnitude
 * of the balance is the amount drawn.
 */
export function computeCreditRows(
  accounts: Account[],
  convert: (value: number, from: string, to: string) => number | null,
  displayCurrency: string,
): CreditUtilizationRow[] {
  return accounts.map((account) => {
    const limitNative = effectiveCreditLimit(account);
    const usedNative = Math.abs(Number(account.currentBalance) || 0);
    // Over the limit reads negative, as on an open card drawn past it: a closed
    // card owing 250 has -250 available.
    const availableNative = limitNative - usedNative;
    // A closed card owing a balance has no limit left to divide by; every unit
    // of credit it had is spent, so it reads as fully used rather than 0%.
    const utilizationPercent =
      limitNative > 0
        ? (usedNative / limitNative) * 100
        : account.isClosed && usedNative > 0
          ? 100
          : 0;
    return {
      id: account.id,
      name: account.name,
      accountType: account.accountType,
      currencyCode: account.currencyCode,
      limit: convert(limitNative, account.currencyCode, displayCurrency),
      used: convert(usedNative, account.currencyCode, displayCurrency),
      available: convert(availableNative, account.currencyCode, displayCurrency),
      utilizationPercent,
    };
  });
}

export function computeCreditTotals(
  rows: CreditUtilizationRow[],
): CreditUtilizationTotals {
  // A row with no rate contributes nothing and is named, rather than being
  // counted as a zero limit and a zero balance -- which would quietly improve
  // the utilisation figure the widget exists to warn about.
  const missing = new Set<string>();
  let excludedCount = 0;
  let limit = 0;
  let used = 0;
  let available = 0;
  for (const row of rows) {
    if (row.limit === null || row.used === null || row.available === null) {
      missing.add(row.currencyCode);
      excludedCount += 1;
      continue;
    }
    limit += row.limit;
    used += row.used;
    available += row.available;
  }
  return {
    limit,
    used,
    available,
    // Only closed cards leave the limit at zero; what they owe is fully used,
    // as on their own rows, not 0%.
    utilizationPercent: limit > 0 ? (used / limit) * 100 : used > 0 ? 100 : 0,
    missingCurrencies: [...missing],
    excludedCount,
  };
}
