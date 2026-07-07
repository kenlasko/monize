import { Account } from '@/types/account';
import { chartColors } from '@/lib/chart-colors';

/**
 * Only credit cards and lines of credit with a positive credit limit have a
 * meaningful utilization figure (used / available credit). Shared by the Credit
 * Utilization report and its dashboard widgets.
 */
export const isCreditAccount = (account: Account): boolean =>
  (account.accountType === 'CREDIT_CARD' || account.accountType === 'LINE_OF_CREDIT') &&
  account.creditLimit != null &&
  account.creditLimit > 0 &&
  !account.isClosed;

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
  limit: number;
  used: number;
  available: number;
  utilizationPercent: number;
}

export interface CreditUtilizationTotals {
  limit: number;
  used: number;
  available: number;
  utilizationPercent: number;
}

/**
 * Per-account utilization rows, all amounts converted into `displayCurrency`.
 * Liability balances are stored negative when money is owed, so the magnitude
 * of the balance is the amount drawn.
 */
export function computeCreditRows(
  accounts: Account[],
  convert: (value: number, from: string, to: string) => number,
  displayCurrency: string,
): CreditUtilizationRow[] {
  return accounts.map((account) => {
    const limitNative = Number(account.creditLimit) || 0;
    const usedNative = Math.abs(Number(account.currentBalance) || 0);
    const availableNative = limitNative - usedNative;
    const utilizationPercent = limitNative > 0 ? (usedNative / limitNative) * 100 : 0;
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
  const limit = rows.reduce((sum, r) => sum + r.limit, 0);
  const used = rows.reduce((sum, r) => sum + r.used, 0);
  const available = rows.reduce((sum, r) => sum + r.available, 0);
  return {
    limit,
    used,
    available,
    utilizationPercent: limit > 0 ? (used / limit) * 100 : 0,
  };
}
