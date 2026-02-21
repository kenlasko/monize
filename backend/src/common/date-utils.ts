/**
 * Check if a transaction date is in the future (after today).
 * Future-dated transactions should not affect current account balances.
 */
export function isTransactionInFuture(transactionDate: string): boolean {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return transactionDate > today;
}
