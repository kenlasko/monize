import { SelectQueryBuilder } from "typeorm";

/**
 * Exclusion filters for investment cash-side transactions that would
 * otherwise leak into "spending" or "income" totals.
 *
 * Two layers:
 *  - `accountSubType != 'INVESTMENT_BROKERAGE'` keeps auto-generated
 *    brokerage cash movements out of the account set.
 *  - `NOT EXISTS (investment_transactions ...)` catches the cash-side
 *    transactions that BUY / SELL / DIVIDEND post into a linked
 *    non-investment cash account, which the subtype filter can't see.
 *
 * Callers must have joined the account alias first. The transaction
 * alias defaults to `transaction` but can be overridden.
 */
export function applyInvestmentTransactionFilters<T extends object>(
  qb: SelectQueryBuilder<T>,
  accountAlias: string,
  transactionAlias: string = "transaction",
): SelectQueryBuilder<T> {
  qb.andWhere(
    `(${accountAlias}.accountSubType IS NULL OR ${accountAlias}.accountSubType != 'INVESTMENT_BROKERAGE')`,
  );
  qb.andWhere(
    `NOT EXISTS (SELECT 1 FROM investment_transactions it WHERE it.transaction_id = ${transactionAlias}.id)`,
  );
  return qb;
}
