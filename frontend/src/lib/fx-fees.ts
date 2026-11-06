import { moneyDecimalsForCurrency, roundToEntryPlaces, sumMoney } from './format';
import type { Transaction } from '@/types/transaction';

/**
 * The foreign-transaction fee charged on a transaction, as a positive cost in
 * the account currency (0 for a domestic transaction or when no fee applies).
 *
 * The bank's fee is folded into the account-currency `amount`
 * (amount = round(originalAmount x exchangeRate) + fee, with fee <= 0) for both
 * ordinary and split transactions -- a split's category lines simply sum to
 * that fee-inclusive total -- so it is recovered as
 * round(originalAmount x exchangeRate) - amount. Mirrors the backend
 * `getFxFeeSummary` derivation so the per-row column and the chart agree.
 *
 * The converted base is rounded at the account currency's places
 * (`roundToEntryPlaces` on the row's own `currencyCode`): cents for fiat, a
 * coin's own for a coin account, where cents read a 0.0051 BTC base as 0.01
 * and the fee as -0.0048 BTC. The difference is taken exactly at the account
 * currency's money precision (`moneyDecimalsForCurrency`: four for fiat, a
 * coin's eight), matching the backend.
 */
export function foreignTransactionFee(transaction: Transaction): number {
  if (
    transaction.originalCurrencyCode == null ||
    transaction.originalAmount == null
  ) {
    return 0;
  }
  const base = roundToEntryPlaces(
    Number(transaction.originalAmount) * Number(transaction.exchangeRate),
    transaction.currencyCode,
  );
  // `|| 0` maps an unreadable amount (NaN) to no fee, as before.
  return (
    sumMoney(
      [base, -Number(transaction.amount)],
      moneyDecimalsForCurrency(transaction.currencyCode),
    ) || 0
  );
}
