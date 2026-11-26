import type { Transaction } from '@/types/transaction';

/**
 * Whether a row's amount is the importer's estimate for the other account's
 * leg of a cross-currency transfer (`amount_is_provisional`). Read as
 * `=== true`: a payload without the field (an older server, a test fixture,
 * a write endpoint that returns a partial row) carries no information and is
 * drawn as an ordinary, confirmed amount.
 */
export function isProvisionalAmount(
  transaction: Pick<Transaction, 'amountIsProvisional'> | null | undefined,
): boolean {
  return transaction?.amountIsProvisional === true;
}
