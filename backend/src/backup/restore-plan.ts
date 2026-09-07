/**
 * The restore's table order, its deferred foreign keys, and the Phase-3 repairs
 * that put them back -- as data rather than as a sequence of calls.
 *
 * Why data: the restore has to insert a child after its parent, and any
 * reference that points forward (or at the row's own table) has to be stripped
 * on insert and re-applied once every target row exists. Spelled out as 40
 * consecutive `insertRows(...)` calls plus two hand-maintained lists, that
 * obligation is checkable only by reading all three and holding the schema's
 * foreign keys in your head -- which is how `accounts.linked_loan_account_id`
 * came to be a self-reference that was never deferred, making a valid backup
 * containing an asset linked to its mortgage impossible to restore.
 *
 * Declared here, the same obligation is a property of three arrays, and
 * `restore-plan.spec.ts` parses every foreign key out of `database/schema.sql`
 * and proves it holds -- for the columns that exist today and for whichever
 * column a future migration adds.
 */

/** One table's place in the restore, in insertion order. */
export interface RestoreStep {
  /**
   * Physical table name. Also the key the export writes it under in the backup
   * envelope -- the two are deliberately identical so neither can drift.
   */
  table: string;
  /**
   * Key the restored row count is reported under in the API response. Always
   * the lowerCamelCase form of `table`; asserted by the guard test rather than
   * derived, so a rename cannot silently change a published response field.
   */
  countKey: string;
  /**
   * Whether `insertRows` forces `user_id` to the restoring user. False for
   * tables with no `user_id` column, which are scoped transitively through
   * their parent's foreign key.
   */
  scopeToUser: boolean;
}

/**
 * User-scoped tables the restore deliberately does NOT clear before inserting,
 * each with the reason it is an exception.
 *
 * Not clearing is normally a bug: the insert is `ON CONFLICT DO NOTHING`, so
 * an uncleared table keeps whatever the destination already had and silently
 * drops the archive's rows -- restore-over-existing stops reproducing the
 * artifact, which is how `notification_preferences` once shipped. The guard in
 * `restore-plan.spec.ts` fails any user-scoped table missing its `DELETE`, and
 * reads this map so that an accidental omission still fails while a decided
 * one is on the record with its argument.
 *
 * The bar for an entry: the table is not user CONTENT but a record of
 * something already spent or already done, where the destination's own row is
 * the more truthful of the two and losing the archive's is the safe outcome.
 */
export const PRESERVED_ON_RESTORE: ReadonlyMap<string, string> = new Map([
  [
    "payee_lookup_usage",
    "Google Places requests already spent this month against the user's own " +
      "key. A machine with no row takes the archive's count, which is what " +
      "carries a month's spend to a new machine; a machine that has one keeps " +
      "it, so no restore can lower a live count and hand back quota that " +
      "Google has already billed for.",
  ],
]);

/**
 * FK-safe insertion order. A table may only appear after every table it
 * references, unless the referencing column is listed in
 * `DEFERRED_FK_COLUMNS` and repaired by `DEFERRED_FK_REPAIRS`.
 *
 * `currencies` is deliberately absent: shared rows keyed by `code`, restored
 * separately by `ensureCurrenciesExist`, never through `insertRows`.
 */
export const RESTORE_PLAN: ReadonlyArray<RestoreStep> = [
  { table: "user_preferences", countKey: "userPreferences", scopeToUser: true },
  {
    table: "user_currency_preferences",
    countKey: "userCurrencyPreferences",
    scopeToUser: true,
  },
  { table: "categories", countKey: "categories", scopeToUser: true },
  { table: "payees", countKey: "payees", scopeToUser: true },
  { table: "payee_aliases", countKey: "payeeAliases", scopeToUser: true },
  { table: "institutions", countKey: "institutions", scopeToUser: true },
  { table: "accounts", countKey: "accounts", scopeToUser: true },
  { table: "tags", countKey: "tags", scopeToUser: true },
  {
    table: "scheduled_transactions",
    countKey: "scheduledTransactions",
    scopeToUser: true,
  },
  {
    table: "scheduled_transaction_splits",
    countKey: "scheduledTransactionSplits",
    scopeToUser: false,
  },
  {
    table: "scheduled_transaction_overrides",
    countKey: "scheduledTransactionOverrides",
    scopeToUser: false,
  },
  {
    // After `scheduled_transactions`, which it references. No user_id column of
    // its own -- ownership comes through the schedule, like the two above.
    table: "scheduled_transaction_postings",
    countKey: "scheduledTransactionPostings",
    scopeToUser: false,
  },
  {
    table: "scheduled_transaction_split_tags",
    countKey: "scheduledTransactionSplitTags",
    scopeToUser: false,
  },
  { table: "securities", countKey: "securities", scopeToUser: true },
  { table: "security_prices", countKey: "securityPrices", scopeToUser: false },
  {
    table: "security_documents",
    countKey: "securityDocuments",
    scopeToUser: true,
  },
  { table: "holdings", countKey: "holdings", scopeToUser: false },
  { table: "security_tags", countKey: "securityTags", scopeToUser: false },
  { table: "transactions", countKey: "transactions", scopeToUser: true },
  {
    table: "transaction_splits",
    countKey: "transactionSplits",
    scopeToUser: false,
  },
  {
    table: "transaction_attachments",
    countKey: "transactionAttachments",
    scopeToUser: true,
  },
  // attachment_blobs has no user_id; it is scoped transitively through its FK
  // to transaction_attachments. The base64 `data` column is decoded to bytea by
  // insertRows (auto-detected from information_schema).
  {
    table: "attachment_blobs",
    countKey: "attachmentBlobs",
    scopeToUser: false,
  },
  {
    table: "transaction_tags",
    countKey: "transactionTags",
    scopeToUser: false,
  },
  {
    table: "transaction_split_tags",
    countKey: "transactionSplitTags",
    scopeToUser: false,
  },
  {
    table: "investment_transactions",
    countKey: "investmentTransactions",
    scopeToUser: true,
  },
  {
    table: "loan_rate_changes",
    countKey: "loanRateChanges",
    scopeToUser: true,
  },
  { table: "loan_scenarios", countKey: "loanScenarios", scopeToUser: true },
  { table: "budgets", countKey: "budgets", scopeToUser: true },
  {
    table: "budget_categories",
    countKey: "budgetCategories",
    scopeToUser: false,
  },
  { table: "budget_periods", countKey: "budgetPeriods", scopeToUser: false },
  {
    table: "budget_period_categories",
    countKey: "budgetPeriodCategories",
    scopeToUser: false,
  },
  { table: "notifications", countKey: "notifications", scopeToUser: true },
  {
    table: "notification_preferences",
    countKey: "notificationPreferences",
    scopeToUser: true,
  },
  {
    // After notifications: source_notification_id references notifications(id).
    table: "notification_reminders",
    countKey: "notificationReminders",
    scopeToUser: true,
  },
  {
    // Only references users(id); one row per user (the portfolio-movement
    // baseline + threshold).
    table: "notification_portfolio_state",
    countKey: "notificationPortfolioState",
    scopeToUser: true,
  },
  { table: "custom_reports", countKey: "customReports", scopeToUser: true },
  {
    table: "investment_reports",
    countKey: "investmentReports",
    scopeToUser: true,
  },
  {
    table: "import_column_mappings",
    countKey: "importColumnMappings",
    scopeToUser: true,
  },
  {
    table: "monthly_account_balances",
    countKey: "monthlyAccountBalances",
    scopeToUser: true,
  },
  {
    table: "auto_backup_settings",
    countKey: "autoBackupSettings",
    scopeToUser: true,
  },
  {
    table: "ai_provider_configs",
    countKey: "aiProviderConfigs",
    scopeToUser: true,
  },
  {
    table: "payee_lookup_settings",
    countKey: "payeeLookupSettings",
    scopeToUser: true,
  },
  {
    // The user's own Google Places month counters. Unlike every other step
    // here, the restore does not clear this table first: the generic insert's
    // ON CONFLICT DO NOTHING then means a machine with no row takes the
    // archive's count (the migration this exists for) while a machine that
    // already has one keeps its own, so a restore can never lower a live
    // count and hand back quota the key has already spent.
    table: "payee_lookup_usage",
    countKey: "payeeLookupUsage",
    scopeToUser: true,
  },
  {
    table: "monte_carlo_scenarios",
    countKey: "monteCarloScenarios",
    scopeToUser: true,
  },
  {
    table: "monte_carlo_cash_flows",
    countKey: "monteCarloCashFlows",
    scopeToUser: false,
  },
  // GEM strategies last: the children reference securities and accounts, both
  // already inserted above, and each other only through gem_strategies.
  { table: "gem_strategies", countKey: "gemStrategies", scopeToUser: true },
  {
    table: "gem_strategy_accounts",
    countKey: "gemStrategyAccounts",
    scopeToUser: true,
  },
  {
    table: "gem_strategy_assets",
    countKey: "gemStrategyAssets",
    scopeToUser: true,
  },
  {
    table: "gem_strategy_signals",
    countKey: "gemStrategySignals",
    scopeToUser: true,
  },
];

/**
 * Tables `insertRows` is permitted to write. Derived from the plan so the
 * allowlist and the order cannot disagree.
 */
export const RESTORABLE_TABLES: ReadonlySet<string> = new Set(
  RESTORE_PLAN.map((step) => step.table),
);

/**
 * Columns stripped on insert because they reference a row that does not exist
 * yet -- a forward reference to a later table, or a reference into the row's
 * own table. Every entry here must be repaired by `DEFERRED_FK_REPAIRS`.
 */
export const DEFERRED_FK_COLUMNS: Readonly<Record<string, readonly string[]>> =
  {
    categories: ["parent_id"],
    accounts: [
      "linked_account_id",
      "source_account_id",
      // Self-referential: an asset account points at the loan financing it, and
      // the loan can sort after the asset in the export's ORDER BY name. Left
      // inline it raised a foreign-key violation that rolled back the whole
      // restore for any user who linked a property to its mortgage.
      "linked_loan_account_id",
      "scheduled_transaction_id",
      "principal_category_id",
      "interest_category_id",
      "asset_category_id",
      // Deferred so that legacy backups (taken before institutions were
      // included in the export) restore without violating fk_accounts_institution.
      // Phase 3 only re-applies it when the referenced institution exists.
      "institution_id",
    ],
    transactions: ["linked_transaction_id", "parent_transaction_id"],
    // Self-referential: a scan pair's original points at the visible
    // attachment, and the export's ORDER BY id can put the original first.
    transaction_attachments: ["original_of_attachment_id"],
    payees: ["default_category_id"],
    // Scheduled transactions/splits are inserted before securities, so their
    // forward reference to securities(id) is deferred to Phase 3.
    scheduled_transactions: ["investment_security_id"],
    scheduled_transaction_splits: ["investment_security_id"],
    // Self-referential FK linking the two legs of a security transfer
    // (TRANSFER_OUT <-> TRANSFER_IN). A row may reference another
    // investment_transactions row that appears later in the insert batch.
    investment_transactions: ["linked_transaction_id"],
  };

/** One Phase-3 `UPDATE` putting a deferred foreign key back. */
export interface DeferredFkRepair {
  table: string;
  column: string;
  /**
   * When set, the UPDATE only applies if a row with the referenced id exists in
   * this table. Used for `institution_id` so legacy backups that predate
   * institution export leave the column NULL instead of failing.
   */
  requireReferencedTable?: string;
}

/**
 * Phase-3 repairs, applied after every table is populated. Order is
 * irrelevant -- by this point every target row exists -- but it mirrors
 * `DEFERRED_FK_COLUMNS` so the two read as one list.
 */
export const DEFERRED_FK_REPAIRS: ReadonlyArray<DeferredFkRepair> = [
  { table: "categories", column: "parent_id" },
  {
    table: "accounts",
    column: "institution_id",
    requireReferencedTable: "institutions",
  },
  { table: "accounts", column: "linked_account_id" },
  { table: "accounts", column: "source_account_id" },
  { table: "accounts", column: "linked_loan_account_id" },
  { table: "accounts", column: "scheduled_transaction_id" },
  { table: "accounts", column: "principal_category_id" },
  { table: "accounts", column: "interest_category_id" },
  { table: "accounts", column: "asset_category_id" },
  { table: "transactions", column: "linked_transaction_id" },
  { table: "transactions", column: "parent_transaction_id" },
  { table: "transaction_attachments", column: "original_of_attachment_id" },
  { table: "investment_transactions", column: "linked_transaction_id" },
  { table: "payees", column: "default_category_id" },
  { table: "scheduled_transactions", column: "investment_security_id" },
  { table: "scheduled_transaction_splits", column: "investment_security_id" },
];
