/**
 * What another surface hands the New Transaction form to start from: Quick
 * Add's "Full Form" (`docs/future-plans/quick-add.md`, "The dialog"). It seeds a
 * NEW entry only; an edit or a duplicate ignores it, and so do the payee and
 * date defaults the other hosts pass.
 *
 * Every field is optional: a blocked entry is handed over too, so whatever the
 * line did not settle stays empty for the reader to fill in.
 */
export interface TransactionFormDraft {
  mode: 'normal' | 'transfer';
  /** The account, or a transfer's FROM account. */
  accountId?: string;
  /** A transfer's TO account. */
  toAccountId?: string;
  /**
   * In the account's currency. Signed for a transaction (a payment negative,
   * a deposit positive); a transfer's magnitude, which the form keeps positive.
   */
  amount?: number;
  /** YYYY-MM-DD. */
  date?: string;
  payeeId?: string;
  /** The payee's name; alone (no `payeeId`) it is a payee the save creates. */
  payeeName?: string;
  categoryId?: string;
  description?: string;
}
