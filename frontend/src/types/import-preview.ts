/**
 * What a preview of an import says about one row, whatever the source (a bank
 * sync today; a file import later). Nothing here names a bank: the shapes
 * mirror `backend/src/import-preview/import-preview.types.ts`.
 */
import type { RuleRunChanges } from '@/types/transaction-rule-run';

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
