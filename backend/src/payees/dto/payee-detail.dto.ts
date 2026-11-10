import { Payee } from "../entities/payee.entity";

/**
 * One account the payee has been transacted from. `total` is the signed sum of
 * the payee's transactions in that account, in the account's own currency --
 * accounts are single-currency, so no conversion happens here and none should:
 * display currency is a client concern.
 */
export interface PayeeAccountBreakdownRow {
  accountId: string;
  accountName: string;
  accountType: string;
  currencyCode: string;
  transactionCount: number;
  total: number;
  lastTransactionDate: string | null;
  /** The reader's reporting currency, which `convertedTotal` is in. */
  convertedCurrency: string;
  /**
   * `total` with each part at its own settled rate or the market rate on its
   * own date (issue #2106); null while a part has no admissible rate.
   */
  convertedTotal: number | null;
}

/** The payee's single largest transaction by absolute amount, linked from the page. */
export interface PayeeLargestTransaction {
  id: string;
  transactionDate: string;
  amount: number;
  currencyCode: string;
  accountId: string;
  accountName: string;
  description: string | null;
}

/**
 * Lifetime facts about the payee's history. Counts use the analytics scope
 * (non-void, split children excluded) so they agree with the register summary
 * and the analytics endpoints the detail page composes -- not the payee list's
 * raw join count, which includes voids.
 */
export interface PayeeDetailStats {
  transactionCount: number;
  firstTransactionDate: string | null;
  lastTransactionDate: string | null;
  /** Transactions a default-category backfill would touch (see payee-backfill.util). */
  uncategorizedCount: number;
  aliasCount: number;
}

/**
 * Everything the payee detail page needs beyond what the generic, payee-filterable
 * analytics endpoints already provide. Identity and facts only: totals over time,
 * category breakdowns and recurring cadence stay on the transactions analytics
 * endpoints, which the page queries directly with `payeeIds=[id]`.
 */
export interface PayeeDetailDto {
  payee: Payee;
  stats: PayeeDetailStats;
  accounts: PayeeAccountBreakdownRow[];
  largestTransaction: PayeeLargestTransaction | null;
  /** Loan accounts that designate this payee as their overpayment payee. */
  overpaymentForAccounts: { accountId: string; accountName: string }[];
}
