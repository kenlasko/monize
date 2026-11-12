import type { EntityManager } from "typeorm";
import { detachSharedLedgerForErasure } from "../shared-expenses/shared-erasure";

/**
 * Tables holding the demo user's data, in an order that never trips a foreign
 * key that does not cascade: a table comes before every table it is referenced
 * by without `ON DELETE CASCADE`. Children that cascade from a table here
 * (splits, allocations, participants, ...) are not listed.
 *
 * Each entry is `[table, ownerColumn]`; the clear is `DELETE ... WHERE
 * ownerColumn = $1`. `demo-clear.spec.ts` reads `database/schema.sql` and fails
 * when a table with an owner column is neither listed here nor excluded below,
 * so a feature that adds a user-owned table cannot leave its rows behind in the
 * demo after the daily reset.
 */
export const DEMO_CLEAR_TABLES: readonly (readonly [string, string])[] = [
  // The shared-expense bridge references the ledger rows it created.
  ["shared_ledger_links", "user_id"],
  ["investment_transactions", "user_id"],
  ["security_documents", "user_id"],
  ["transactions", "user_id"],
  ["shared_postings", "user_id"],
  ["shared_integrations", "user_id"],
  ["scheduled_transactions", "user_id"],
  ["securities", "user_id"],
  ["monthly_account_balances", "user_id"],
  ["warranties", "user_id"],
  ["loan_fees", "user_id"],
  ["loan_rate_changes", "user_id"],
  ["loan_scenarios", "user_id"],
  ["gem_strategies", "user_id"],
  ["monte_carlo_scenarios", "user_id"],
  ["bank_sync_connections", "user_id"],
  ["import_jobs", "user_id"],
  ["import_staged_files", "user_id"],
  ["import_column_mappings", "user_id"],
  ["email_receipts", "user_id"],
  ["email_receipt_mailboxes", "user_id"],
  ["email_receipt_parsers", "user_id"],
  ["ai_review_requests", "user_id"],
  ["transaction_rules", "user_id"],
  ["budgets", "user_id"],
  ["tags", "user_id"],
  ["calendar_day_notes", "user_id"],
  ["custom_reports", "user_id"],
  ["investment_reports", "user_id"],
  ["notifications", "user_id"],
  ["notification_reminders", "user_id"],
  ["notification_portfolio_state", "user_id"],
  ["notification_preferences", "user_id"],
  ["action_history", "user_id"],
  ["dashboard_trivia", "user_id"],
  ["ai_insights", "user_id"],
  ["ai_usage_logs", "user_id"],
  ["ai_relay_actions", "user_id"],
  ["ai_relay_agents", "user_id"],
  ["ai_relay_prompts", "user_id"],
  ["ai_relay_attachments", "user_id"],
  ["ai_provider_configs", "user_id"],
  ["personal_access_tokens", "user_id"],
  ["push_subscriptions", "user_id"],
  ["oidc_step_up_claims", "user_id"],
  ["payee_lookup_settings", "user_id"],
  ["payee_lookup_usage", "user_id"],
  ["auto_backup_settings", "user_id"],
  ["backup_offsite_settings", "user_id"],
  ["backup_offsite_uploads", "user_id"],
  ["account_delegates", "owner_user_id"],
  ["emergency_access_contacts", "owner_user_id"],
  ["emergency_access_settings", "owner_user_id"],
  ["user_currency_preferences", "user_id"],
  ["shared_people", "user_id"],
  // Accounts reference shared groups (RESTRICT) through a managed settlement
  // account, so the accounts go first; payees reference categories.
  ["accounts", "user_id"],
  ["shared_groups", "owner_user_id"],
  ["payees", "user_id"],
  ["institutions", "user_id"],
  ["categories", "user_id"],
  ["refresh_tokens", "user_id"],
  ["trusted_devices", "user_id"],
  ["user_preferences", "user_id"],
];

/**
 * Owner-column tables the clear leaves alone, and why. Everything else with an
 * owner column must be in `DEMO_CLEAR_TABLES`.
 */
export const DEMO_CLEAR_EXCLUDED: Readonly<Record<string, string>> = {
  job_claims:
    "holds the 'reset done today' claim that stops a second replica from resetting again",
  // Rows that die with a parent listed above (ON DELETE CASCADE).
  attachment_blob_tombstones: "cascades with the transactions' attachments",
  bank_sync_accounts: "cascades from bank_sync_connections",
  bank_sync_credentials: "cascades from bank_sync_connections",
  bank_sync_imported_transactions: "cascades from bank_sync_connections",
  bank_sync_provider_requests: "cascades from bank_sync_connections",
  email_receipt_links: "cascades from email_receipts",
  gem_strategy_accounts: "cascades from gem_strategies",
  gem_strategy_assets: "cascades from gem_strategies",
  gem_strategy_signals: "cascades from gem_strategies",
  payee_aliases: "cascades from payees",
  payroll_deduction_rule_periods: "cascades from payroll_deduction_rules",
  payroll_deduction_rules: "cascades from scheduled_transactions",
  shared_commands: "cascades from shared_groups",
  shared_delivery_receipts: "cascades from shared_activity",
  shared_memberships: "cascades from shared_groups",
  shared_person_links: "cascades from shared_people and shared_groups",
  transaction_attachments: "cascades from transactions",
  transaction_rule_applications: "cascades from transaction_rules",
  warranty_claims: "cascades from warranties",
  ai_relay_attachment_blobs: "cascades from ai_relay_attachments",
};

/**
 * Delete everything the demo user owns, leaving the user row itself. Run in
 * one transaction by the caller. Tables with a composite child that has no
 * owner column of its own (splits, holdings, prices, allocations) go with their
 * parent by cascade; the few that do not are removed first.
 */
export async function clearDemoUserData(
  manager: EntityManager,
  userId: string,
): Promise<void> {
  // A shared-expense settlement account is bridge-managed: a trigger refuses
  // to delete it while the bridge holds it, so a demo visitor who connected a
  // group to their ledger would roll the whole reset back. Account erasure
  // already has the sanctioned way to release it, so reuse that.
  await detachSharedLedgerForErasure(manager, userId);

  // Children whose foreign key to a parent below does not cascade.
  await manager.query(
    `DELETE FROM holdings WHERE account_id IN
       (SELECT id FROM accounts WHERE user_id = $1)`,
    [userId],
  );
  await manager.query(
    `DELETE FROM security_prices WHERE security_id IN
       (SELECT id FROM securities WHERE user_id = $1)`,
    [userId],
  );

  for (const [table, column] of DEMO_CLEAR_TABLES) {
    await manager.query(`DELETE FROM ${table} WHERE ${column} = $1`, [userId]);
  }
}
