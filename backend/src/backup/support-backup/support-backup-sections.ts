/**
 * Which tables belong to which optional support-backup section, and the non-FK
 * cleanups a disabled section needs.
 *
 * Split out of `support-backup-rules.ts` (which owns the per-column
 * de-identification registry): the section-to-tables mapping is a separate axis
 * from what happens to each column, and keeping the two together pushed the
 * rules file past the repository line ceiling as the schema grew. Re-exported
 * from `support-backup-rules.ts` so existing import sites are unchanged.
 */

export type SupportBackupSection =
  | "investments"
  | "scheduled"
  | "budgets"
  | "reports"
  | "importMappings"
  | "autoBackup";

export const SECTION_TABLES: Record<SupportBackupSection, string[]> = {
  investments: [
    "securities",
    "security_prices",
    "security_documents",
    "holdings",
    "investment_transactions",
    "security_tags",
  ],
  scheduled: [
    "scheduled_transactions",
    "scheduled_transaction_splits",
    "scheduled_transaction_overrides",
    "scheduled_transaction_postings",
    "scheduled_transaction_split_tags",
  ],
  budgets: [
    "budgets",
    "budget_buckets",
    "budget_categories",
    "budget_periods",
    "budget_period_categories",
    "budget_period_buckets",
    "notifications",
    "notification_preferences",
    "notification_reminders",
    "notification_portfolio_state",
  ],
  reports: [
    "custom_reports",
    "investment_reports",
    "monte_carlo_scenarios",
    "monte_carlo_cash_flows",
    "gem_strategies",
    "gem_strategy_accounts",
    "gem_strategy_assets",
    "gem_strategy_signals",
  ],
  importMappings: ["import_column_mappings"],
  autoBackup: ["auto_backup_settings"],
};

/**
 * Cleanups a disabled section needs that the referential-integrity scrub can't
 * do on its own. The scrub already nulls/drops every real FK pointing at a
 * removed table, so those cases are NOT listed here (that would duplicate it).
 * What remains is non-FK references the scrub can't see: id arrays and JSONB
 * blobs. Today the only one is `favourite_report_ids` (a UUID text[] with no
 * FK), reset when the reports section is off.
 */
export interface SectionCleanup {
  table: string;
  column: string;
  resetTo: unknown;
}

export const SECTION_NONFK_CLEANUP: Partial<
  Record<SupportBackupSection, SectionCleanup[]>
> = {
  reports: [
    { table: "user_preferences", column: "favourite_report_ids", resetTo: [] },
  ],
};

/** All tables owned by any section (i.e. not part of the always-in core). */
export const SECTIONED_TABLES: ReadonlySet<string> = new Set(
  Object.values(SECTION_TABLES).flat(),
);
