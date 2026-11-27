/**
 * The Quick Add interpretation contract (`docs/future-plans/quick-add.md`,
 * "Response"). The frontend keeps its own copy of these shapes; a change here
 * is a change to that contract.
 */
import type { CategoryType } from "../../categories/category-type.util";
import type { RuleEffectsPreview } from "../../transaction-rules/transaction-rules-applier.service";

export const QUICK_ADD_KINDS = ["payment", "deposit", "transfer"] as const;
export type QuickAddKind = (typeof QUICK_ADD_KINDS)[number];

/** Fields a reader can clear on a chip (`pins.clear`). */
export const QUICK_ADD_CLEARABLE_FIELDS = ["payee", "category"] as const;
export type QuickAddClearableField =
  (typeof QUICK_ADD_CLEARABLE_FIELDS)[number];

/** How a value was arrived at; decides the chip's tier. */
export type QuickAddSource =
  "typed" | "pinned" | "inferred" | "default" | "none";

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

/** `id` null: a new payee. */
export interface QuickAddPayeeRef {
  id: string | null;
  name: string;
}

/** `name` is the "Parent: Child" path. */
export interface QuickAddCategoryRef {
  id: string;
  name: string;
}

export type QuickAddBlocker =
  | "missingAmount"
  | "zeroAmount"
  | "amountPrecision"
  | "missingAccount"
  | "ambiguousAccount"
  | "missingToAccount"
  | "sameAccount"
  /** Above the create DTO's `TRANSACTION_AMOUNT_MAX_MAGNITUDE`. */
  | "amountTooLarge"
  /** A currency was typed that is not the account's. */
  | "foreignCurrency"
  /** The two accounts hold different currencies. */
  | "crossCurrencyTransfer";

export interface QuickAddBalance {
  accountId: string;
  currencyCode: string;
  current: number;
  /** Null when the save does not move the current balance today (a future date). */
  after: number | null;
  /** The date the balance moves when `after` is null. */
  movesOn: string | null;
}

/** The figure as typed in a currency (`QuickAddInterpretation.foreignAmount`). */
export interface QuickAddForeignAmount {
  /** The ISO code when the typed symbol or code names one currency, else null. */
  currencyCode: string | null;
  /** The typed magnitude. */
  amount: number;
}

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
  /** Why Save is refused; empty means the entry can be saved as shown. */
  blockers: QuickAddBlocker[];
  /** The account's balance before and after the save, or null without an account and amount. */
  balance: QuickAddBalance | null;
  /**
   * The figure as typed in a currency: set when `foreignCurrency` blocks, and
   * when a currency was typed but no account is known yet to compare it with.
   */
  foreignAmount: QuickAddForeignAmount | null;
  /** What the reader's transaction rules will change on save (the planner the commit runs). */
  ruleEffects?: RuleEffectsPreview;
}

/**
 * An account the reader may enter into: owned, open, not a brokerage and not
 * a shared-expense settlement account.
 */
export interface QuickAddCandidateAccount {
  readonly id: string;
  readonly name: string;
  readonly currencyCode: string;
  readonly currentBalance: number;
}

/** An active payee, with its import aliases. */
export interface QuickAddCandidatePayee {
  readonly id: string;
  readonly name: string;
  readonly defaultCategoryId: string | null;
  readonly aliases: readonly string[];
}

export interface QuickAddCandidateCategory {
  readonly id: string;
  /** The leaf name. */
  readonly name: string;
  /** "Parent: Child", or the leaf for a top-level category. */
  readonly path: string;
  /** Income or Expense: a Transfer category is never a quick-add candidate. */
  readonly categoryType: CategoryType;
}
