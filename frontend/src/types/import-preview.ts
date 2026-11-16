/**
 * What a preview of an import says about one row, whatever the source (a bank
 * sync today; a file import later). Nothing here names a bank: the shapes
 * mirror `backend/src/import-preview/import-preview.types.ts`.
 */
import type { RuleRunChanges } from '@/types/transaction-rule-run';

/**
 * What a person can decide about a possible duplicate
 * (docs/specs/import-duplicate-review.md section 3): import it beside the
 * existing transaction, merge it into it, keep the existing one, or delete the
 * existing one and import it.
 */
export type ImportDuplicateAction = 'import' | 'merge' | 'keep' | 'replace';

/** The transaction already in the account that an incoming row looks like. */
export interface ImportDuplicateExisting {
  id: string;
  transactionDate: string;
  /** Signed amount as a decimal string. */
  amount: string;
  payeeName: string | null;
  categoryName: string | null;
  description: string | null;
  referenceNumber: string | null;
  status: 'UNRECONCILED' | 'CLEARED' | 'RECONCILED' | 'VOID';
  isTransfer: boolean;
  isSplit: boolean;
  /** The other leg's account, for a transfer; null when it cannot be read. */
  transferAccountName: string | null;
}

/**
 * How a row's payee resolves: an existing payee of that exact name, an alias
 * pattern, a payee the import would create, an import rule, or none.
 */
export type ImportPreviewPayeeVia = 'name' | 'alias' | 'new' | 'rule' | 'none';

export interface ImportPreviewPayee {
  /** The source's counterparty text; null when it gave none. */
  original: string | null;
  /** The payee the transaction would carry after the rules; null for none. */
  name: string | null;
  via: ImportPreviewPayeeVia;
  /** The alias pattern that matched; null unless `via` is `alias` and it was found. */
  aliasPattern: string | null;
  /** The existing payee's id, for the link to its aliases; null while none exists. */
  payeeId: string | null;
}

/** One import rule that matched a row, with what it changed (ids named by the labels). */
export interface ImportPreviewRule {
  ruleId: string;
  ruleName: string | null;
  changes: RuleRunChanges;
  applied: Array<{ type: string }>;
  skipped: Array<{ type: string; reason: string }>;
  /** True when this rule ended the pass. */
  stopped: boolean;
}

/** Names for the ids the rule traces mention, so no raw id reaches the screen. */
export interface ImportPreviewLabels {
  categories: Record<string, string>;
  payees: Record<string, string>;
  tags: Record<string, string>;
}

/**
 * The exact input the import rules are planned over for one row, as a sync
 * would hand it (`backend/src/transaction-rules/transaction-rules-applier.service.ts`,
 * `RuleRowInput`). A preview row carries it so the rule test can ask the server
 * why each rule did or did not apply; nothing in the browser reads a field of
 * it, it is sent back as it came.
 */
export interface ImportPreviewRuleInput {
  accountId: string;
  currencyCode: string | null;
  /** A decimal string or a number, signed, in the account currency. */
  amount: number | string | null;
  isTransfer: boolean;
  fromAccountId?: string | null;
  toAccountId?: string | null;
  payeeId: string | null;
  /** The raw payee text the source supplied. */
  payeeText: string | null;
  categoryId: string | null;
  description: string | null;
  tagIds: string[];
  hasSplits: boolean;
  referenceNumber?: string | null;
  /** `YYYY-MM-DD`. */
  transactionDate?: string | null;
  status?: string | null;
  hasAttachment?: boolean;
  /** The name stored on the row, for the trace of a payee change. */
  payeeName?: string | null;
}
