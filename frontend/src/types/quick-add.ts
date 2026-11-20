import type { PendingActionRuleEffects } from '@/types/ai';

/**
 * The client copy of the Quick Add contract, `POST /transactions/quick-add/interpret`
 * (`docs/future-plans/quick-add.md`, "Request" and "Response"). The server reads
 * the typed line; the client only displays the reading and, on save, sends the
 * fields it shows to the existing `POST /transactions` or
 * `POST /transactions/transfer`.
 */

/** What a line can be saved as here; anything else is finished in the full form. */
export type QuickAddKind = 'payment' | 'deposit' | 'transfer';

export const QUICK_ADD_KINDS: readonly QuickAddKind[] = ['payment', 'deposit', 'transfer'];

/** How a value was arrived at; decides the chip's tier. */
export type QuickAddSource = 'typed' | 'pinned' | 'inferred' | 'default' | 'none';

export interface QuickAddField<T> {
  value: T | null;
  source: QuickAddSource;
  /** Two or more candidates matched equally well; `value` is the most used. */
  ambiguous: boolean;
  /** Other candidates, most likely first, at most 5. */
  alternatives: T[];
}

export interface QuickAddAccountRef {
  id: string;
  name: string;
  currencyCode: string;
}

/** `id` null: a new payee, created by the save. */
export interface QuickAddPayeeRef {
  id: string | null;
  name: string;
}

/** `name` is the "Parent: Child" path. */
export interface QuickAddCategoryRef {
  id: string;
  name: string;
}

/** Why Save is refused; each names one thing the reader has to fix. */
export type QuickAddBlocker =
  | 'missingAmount'
  | 'zeroAmount'
  | 'amountPrecision'
  | 'missingAccount'
  | 'ambiguousAccount'
  | 'missingToAccount'
  | 'sameAccount'
  /** A currency was typed that is not the account's. */
  | 'foreignCurrency'
  /** The two accounts hold different currencies. */
  | 'crossCurrencyTransfer';

/** The FROM account's balance before and after the save. */
export interface QuickAddBalance {
  accountId: string;
  currencyCode: string;
  current: number;
  /** Null when the save does not move the current balance today (a future date). */
  after: number | null;
  /** The date the balance moves when `after` is null. */
  movesOn: string | null;
}

/**
 * What the reader's transaction rules will change on save: the server's
 * `RuleEffectsPreview`, read through the shape the assistant's cards already
 * render (the trace is not read).
 */
export type QuickAddRuleEffects = PendingActionRuleEffects;

export interface QuickAddInterpretation {
  kind: QuickAddField<QuickAddKind>;
  /** Magnitude, rounded at the account currency's places. */
  amount: QuickAddField<number>;
  /** YYYY-MM-DD. */
  date: QuickAddField<string>;
  /** The FROM account of a transfer. */
  account: QuickAddField<QuickAddAccountRef>;
  /** Transfers only; value null otherwise. */
  toAccount: QuickAddField<QuickAddAccountRef>;
  payee: QuickAddField<QuickAddPayeeRef>;
  /** Payments and deposits only. */
  category: QuickAddField<QuickAddCategoryRef>;
  /** Words nothing else used. */
  memo: string | null;
  /** Empty means the entry can be saved as shown. */
  blockers: QuickAddBlocker[];
  /** Null without an account and an amount. */
  balance: QuickAddBalance | null;
  ruleEffects?: QuickAddRuleEffects;
}

/** Fields the reader set by hand on a chip; every one is optional. */
export interface QuickAddPins {
  kind?: QuickAddKind;
  /** Magnitude, above zero. */
  amount?: number;
  /** YYYY-MM-DD. */
  date?: string;
  accountId?: string;
  toAccountId?: string;
  payeeId?: string;
  /** A new payee's name. */
  payeeName?: string;
  categoryId?: string;
}

export interface QuickAddInterpretRequest {
  /** At most 200 characters; may be empty. */
  text: string;
  /** YYYY-MM-DD, the reader's `useFinancialToday()`. */
  today: string;
  /** The register's single filtered account, if any. */
  contextAccountId?: string;
  pins?: QuickAddPins;
}
