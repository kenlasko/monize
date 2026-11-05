import { roundToEntryPlaces } from './format';
import type { Transaction } from '@/types/transaction';

// Integer ten-thousandths, matching the backend roundMoney / decimal(20,4).
const SCALE = 10000;

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
 * and the fee as -0.0048 BTC.
 */
export function foreignTransactionFee(transaction: Transaction): number {
  if (
    transaction.originalCurrencyCode == null ||
    transaction.originalAmount == null
  ) {
    return 0;
  }
  const baseCents = Math.round(
    roundToEntryPlaces(
      Number(transaction.originalAmount) * Number(transaction.exchangeRate),
      transaction.currencyCode,
    ) * SCALE,
  );
  const amountCents = Math.round(Number(transaction.amount) * SCALE);
  // `|| 0` normalizes -0 to 0.
  return (baseCents - amountCents) / SCALE || 0;
}
