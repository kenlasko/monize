/**
 * Row shapes of the raw statements `NetWorthService` runs through its scoped
 * query door. Each mirrors the SELECT list of one statement, as the driver
 * returns it: NUMERIC columns arrive as strings (read through `Number`), and a
 * DATE column is typed `string | Date` because the string parser is installed
 * in `main.ts` only, so a spec driving the service may hand back a `Date`.
 */

/** A PostgreSQL NUMERIC as the driver returns it (or a test fixture writes it). */
export type NumericColumn = string | number;

/** A DATE / TIMESTAMP column; see the module comment. */
export type DateColumn = string | Date;

/** One `monthly_account_balances` row joined to its account. */
export interface MonthlySnapshotRow {
  timing_family?: "expense" | "income";
  valuation_date?: string;
  month: DateColumn;
  balance: NumericColumn;
  market_value: NumericColumn | null;
  account_id: string;
  account_type: string;
  account_sub_type: string | null;
  currency_code: string;
}

/** An account's first snapshot month. */
export interface FirstMonthRow {
  account_id: string;
  first_month: DateColumn;
}

/** A priced trade feeding the first-active-month cost basis. */
export interface FirstMonthTradeRow {
  account_id: string;
  action: string;
  quantity: NumericColumn | null;
  price: NumericColumn | null;
  transaction_date: DateColumn;
  security_currency: string | null;
}

/** An investment account in a valuation scope. */
export interface ScopedInvestmentAccountRow {
  id: string;
  account_type: string;
  account_sub_type: string | null;
  currency_code: string;
  opening_balance: NumericColumn;
}

/** One investment transaction of a holdings replay. */
export interface ReplayTransactionRow {
  account_id: string;
  security_id: string | null;
  action: string;
  quantity: NumericColumn | null;
  transaction_date: DateColumn;
}

/** A cash account's balance at the close of one day. */
export interface DailyCashBalanceRow {
  date: string;
  balance: NumericColumn;
  account_id: string;
}

/** A cash account's balance at the end of one month. */
export interface MonthlyCashBalanceRow {
  account_id: string;
  month: string;
  balance: NumericColumn;
}

/** A running monthly balance of one account. */
export interface MonthlyBalanceRow {
  month: DateColumn;
  balance: NumericColumn;
}

/** The earliest ledger movement of one account. */
export interface EarliestRow {
  earliest: DateColumn | null;
}

/** The earliest investment transaction of one account. */
export interface InvestmentEarliestRow {
  inv_earliest: DateColumn | null;
}

/** One stored close from `security_prices`. */
export interface StoredPriceRow {
  security_id: string;
  price_date: DateColumn;
  close_price: NumericColumn;
}

/** One day's averaged transaction price, the legacy fallback series. */
export interface TransactionPriceRow {
  security_id: string;
  transaction_date: DateColumn;
  price: NumericColumn;
}
