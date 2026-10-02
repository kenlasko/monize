/**
 * What a preview of an import says about one row, whatever the source (a bank
 * sync today; a file import later). Nothing here names a bank, a provider or a
 * file format: the shapes are the answer to "how did this row's payee resolve"
 * and "which rules matched it and what did they change". The frontend mirrors
 * them in `frontend/src/types/import-preview.ts`.
 */

/**
 * How a row's payee resolves: an existing payee of exactly that name (`name`),
 * an alias pattern matched (`alias`), a payee the import would create (`new`),
 * an import rule sets it (`rule`), or no payee (`none`).
 */
export type ImportPreviewPayeeVia = "name" | "alias" | "new" | "rule" | "none";

/**
 * Where a row's payee comes from: the source's text, the payee it resolves to
 * and how. `name` is the payee the transaction would carry after the rules.
 */
export interface ImportPreviewPayeeView {
  /** The source's counterparty text (or first remittance line); null when it gave none. */
  original: string | null;
  /** The payee the transaction would carry; null when it would have none. */
  name: string | null;
  via: ImportPreviewPayeeVia;
  /** The alias pattern that matched; set only for `alias`, and only when it could be found. */
  aliasPattern: string | null;
  /** The existing payee's id, for the link to its aliases; null while none exists yet. */
  payeeId: string | null;
}

/**
 * What a rule changed on one row, in the `{field: {before, after}}` shape of the
 * rules API (`RuleTraceChanges`), with ids; the labels name them.
 */
export interface ImportPreviewRuleChanges {
  categoryId?: { before: string | null; after: string | null };
  payeeId?: { before: string | null; after: string | null };
  payeeName?: { before: string | null; after: string | null };
  payeeCreated?: boolean;
  description?: { before: string | null; after: string | null };
  tagIds?: { before: string[]; after: string[] };
}

/** One import rule that matched a row. */
export interface ImportPreviewRuleView {
  ruleId: string;
  ruleName: string | null;
  changes: ImportPreviewRuleChanges;
  applied: Array<{ type: string }>;
  skipped: Array<{ type: string; reason: string }>;
  /** True when this rule ended the pass (`stopProcessing`). */
  stopped: boolean;
}

/** Names for the ids the rule traces mention, so no raw id reaches the screen. */
export interface ImportPreviewLabels {
  categories: Record<string, string>;
  payees: Record<string, string>;
  tags: Record<string, string>;
}
