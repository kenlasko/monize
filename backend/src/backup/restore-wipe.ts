import { EntityManager } from "typeorm";

/**
 * The FK-safe teardown of everything a user owns, before a restore inserts
 * the archive's rows. Runs on the caller's manager inside the restore's one
 * `withScopedDb` transaction and opens none of its own, so a failed restore
 * leaves the account as it was. Moved out of `BackupRestoreDatabaseService`
 * to keep that file under the module's line ceiling; the service delegates.
 */
export async function deleteAllUserData(
  userId: string,
  manager: EntityManager,
): Promise<void> {
  // Delete in FK-safe order (reverse of insert order)
  await manager.query("DELETE FROM accrual_allocations WHERE user_id = $1", [
    userId,
  ]);
  await manager.query("DELETE FROM accrual_schedules WHERE user_id = $1", [
    userId,
  ]);
  await manager.query(
    "DELETE FROM accrual_system_accounts WHERE user_id = $1",
    [userId],
  );

  // Action history (undo/redo log) -- not included in backups, so wipe it
  // outright; restored data should not be undoable to the prior state.
  await manager.query("DELETE FROM action_history WHERE user_id = $1", [
    userId,
  ]);

  // Transaction rules (their trace rows cascade from the rule and from the
  // transactions deleted below; the trace is not part of a backup).
  await manager.query("DELETE FROM transaction_rules WHERE user_id = $1", [
    userId,
  ]);

  // Email-receipt parsers. The stored receipts and the mailbox are not part of
  // a backup and are left alone; a receipt's parser_id is ON DELETE SET NULL.
  await manager.query("DELETE FROM email_receipt_parsers WHERE user_id = $1", [
    userId,
  ]);

  // GEM strategies (accounts, assets and signals cascade on strategy delete,
  // but are deleted explicitly first so the order is self-documenting)
  await manager.query("DELETE FROM gem_strategy_signals WHERE user_id = $1", [
    userId,
  ]);
  await manager.query("DELETE FROM gem_strategy_assets WHERE user_id = $1", [
    userId,
  ]);
  await manager.query("DELETE FROM gem_strategy_accounts WHERE user_id = $1", [
    userId,
  ]);
  await manager.query("DELETE FROM gem_strategies WHERE user_id = $1", [
    userId,
  ]);

  // Monte Carlo scenarios (cash flows cascade on scenario delete)
  await manager.query(
    `DELETE FROM monte_carlo_cash_flows WHERE scenario_id IN
     (SELECT id FROM monte_carlo_scenarios WHERE user_id = $1)`,
    [userId],
  );
  await manager.query("DELETE FROM monte_carlo_scenarios WHERE user_id = $1", [
    userId,
  ]);

  // AI provider configs
  await manager.query("DELETE FROM ai_provider_configs WHERE user_id = $1", [
    userId,
  ]);

  // Payee lookup settings (Google Places key and cap).
  await manager.query("DELETE FROM payee_lookup_settings WHERE user_id = $1", [
    userId,
  ]);
  // `payee_lookup_usage` is exported and restored beside it, and is
  // deliberately NOT cleared here. It is a record of what has been spent
  // against a Google key, not user content: with the rows left in place the
  // insert's ON CONFLICT DO NOTHING gives the archive's count to a machine
  // that has none (the migration this exists for) and leaves a live count
  // alone, so no restore can lower one and hand back quota. Deleting first
  // would make an older archive do exactly that.
  //
  // `google_places_instance_usage` is not exported at all: it has no owner,
  // and every user on the deployment spends it.

  // Investment data
  await manager.query(
    "DELETE FROM investment_transactions WHERE user_id = $1",
    [userId],
  );
  // Security tags (join rows cascade from securities/tags, deleted here
  // explicitly before securities so the delete order is self-documenting)
  await manager.query(
    `DELETE FROM security_tags WHERE security_id IN
     (SELECT id FROM securities WHERE user_id = $1)`,
    [userId],
  );
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
  await manager.query("DELETE FROM security_documents WHERE user_id = $1", [
    userId,
  ]);
  // Scheduled transactions and their splits reference securities via
  // investment_security_id. Clear those FKs before deleting securities; the
  // rows themselves are removed in the scheduled-transactions block below.
  await manager.query(
    `UPDATE scheduled_transaction_splits SET investment_security_id = NULL
     WHERE scheduled_transaction_id IN
     (SELECT id FROM scheduled_transactions WHERE user_id = $1)`,
    [userId],
  );
  await manager.query(
    "UPDATE scheduled_transactions SET investment_security_id = NULL WHERE user_id = $1",
    [userId],
  );
  await manager.query("DELETE FROM securities WHERE user_id = $1", [userId]);

  // Budget data
  // Reminders before notifications is not required (source_notification_id is
  // ON DELETE SET NULL), but both are cleared: the insert path is ON CONFLICT
  // DO NOTHING, so without this pre-clear a restore over an existing account
  // keeps the local reminder rows and drops the backup's.
  await manager.query("DELETE FROM notification_reminders WHERE user_id = $1", [
    userId,
  ]);
  await manager.query("DELETE FROM notifications WHERE user_id = $1", [userId]);
  // Per-category channel preferences. The insert path is ON CONFLICT DO
  // NOTHING keyed on (user_id, category), so without this pre-clear a restore
  // over an existing account keeps the local preference rows and silently
  // drops the backup's -- every other user-owned restore-plan table clears
  // here for exactly that reason.
  await manager.query(
    "DELETE FROM notification_preferences WHERE user_id = $1",
    [userId],
  );
  // Portfolio-movement baseline + threshold: one row per user, restored by an
  // insert path with the same over-existing-account hazard, so it clears here
  // too.
  await manager.query(
    "DELETE FROM notification_portfolio_state WHERE user_id = $1",
    [userId],
  );
  await manager.query(
    `DELETE FROM budget_period_categories WHERE budget_period_id IN
     (SELECT bp.id FROM budget_periods bp
      JOIN budgets b ON bp.budget_id = b.id
      WHERE b.user_id = $1)`,
    [userId],
  );
  await manager.query(
    `DELETE FROM budget_periods WHERE budget_id IN
     (SELECT id FROM budgets WHERE user_id = $1)`,
    [userId],
  );
  await manager.query(
    `DELETE FROM budget_categories WHERE budget_id IN
     (SELECT id FROM budgets WHERE user_id = $1)`,
    [userId],
  );
  await manager.query("DELETE FROM budgets WHERE user_id = $1", [userId]);

  // Transaction tags
  await manager.query(
    `DELETE FROM transaction_split_tags WHERE transaction_split_id IN
     (SELECT ts.id FROM transaction_splits ts
      JOIN transactions t ON ts.transaction_id = t.id
      WHERE t.user_id = $1)`,
    [userId],
  );
  await manager.query(
    `DELETE FROM transaction_tags WHERE transaction_id IN
     (SELECT id FROM transactions WHERE user_id = $1)`,
    [userId],
  );

  // Transaction splits
  await manager.query(
    `DELETE FROM transaction_splits WHERE transaction_id IN
     (SELECT id FROM transactions WHERE user_id = $1)`,
    [userId],
  );

  // Transaction attachments (bytes first, then metadata). Both would cascade
  // from the transactions delete below, but we clear them explicitly to match
  // the rest of this FK-ordered teardown.
  await manager.query(
    `DELETE FROM attachment_blobs WHERE attachment_id IN
     (SELECT id FROM transaction_attachments WHERE user_id = $1)`,
    [userId],
  );
  await manager.query(
    "DELETE FROM transaction_attachments WHERE user_id = $1",
    [userId],
  );

  // Warranties and their claims. The transaction link is ON DELETE SET NULL,
  // so the transactions delete below would leave them in place; cleared here,
  // claims first, or the insert's ON CONFLICT DO NOTHING would keep the
  // destination's rows and silently drop the archive's.
  await manager.query("DELETE FROM warranty_claims WHERE user_id = $1", [
    userId,
  ]);
  await manager.query("DELETE FROM warranties WHERE user_id = $1", [userId]);

  // Transactions
  await manager.query("DELETE FROM transactions WHERE user_id = $1", [userId]);

  // Tags
  await manager.query("DELETE FROM tags WHERE user_id = $1", [userId]);

  // Scheduled transactions
  await manager.query(
    `DELETE FROM scheduled_transaction_overrides WHERE scheduled_transaction_id IN
     (SELECT id FROM scheduled_transactions WHERE user_id = $1)`,
    [userId],
  );
  await manager.query(
    `DELETE FROM scheduled_transaction_split_tags WHERE scheduled_transaction_split_id IN
     (SELECT sts.id FROM scheduled_transaction_splits sts
      JOIN scheduled_transactions st ON sts.scheduled_transaction_id = st.id
      WHERE st.user_id = $1)`,
    [userId],
  );
  await manager.query(
    `DELETE FROM scheduled_transaction_splits WHERE scheduled_transaction_id IN
     (SELECT id FROM scheduled_transactions WHERE user_id = $1)`,
    [userId],
  );
  // Clear account FK references to scheduled_transactions before deleting them
  await manager.query(
    "UPDATE accounts SET scheduled_transaction_id = NULL WHERE user_id = $1",
    [userId],
  );
  // Payroll deduction rules cascade from their bill, but an archive that
  // carries none must not leave the destination's rules behind.
  await manager.query(
    "DELETE FROM payroll_deduction_rules WHERE user_id = $1",
    [userId],
  );
  await manager.query("DELETE FROM scheduled_transactions WHERE user_id = $1", [
    userId,
  ]);

  // Monthly account balances
  await manager.query(
    "DELETE FROM monthly_account_balances WHERE user_id = $1",
    [userId],
  );

  // Custom reports, import mappings
  await manager.query("DELETE FROM custom_reports WHERE user_id = $1", [
    userId,
  ]);
  await manager.query("DELETE FROM investment_reports WHERE user_id = $1", [
    userId,
  ]);
  await manager.query("DELETE FROM import_column_mappings WHERE user_id = $1", [
    userId,
  ]);

  // AI data
  await manager.query("DELETE FROM ai_insights WHERE user_id = $1", [userId]);

  // Payees
  await manager.query("DELETE FROM payee_aliases WHERE user_id = $1", [userId]);
  await manager.query("DELETE FROM payees WHERE user_id = $1", [userId]);

  // Loan rate-change history and saved overpayment scenarios (both cascade
  // from accounts, deleted here explicitly before accounts)
  await manager.query("DELETE FROM loan_rate_changes WHERE user_id = $1", [
    userId,
  ]);
  await manager.query("DELETE FROM loan_scenarios WHERE user_id = $1", [
    userId,
  ]);

  // Clear account FK references to categories before deleting accounts
  await manager.query(
    "UPDATE accounts SET principal_category_id = NULL, interest_category_id = NULL, asset_category_id = NULL WHERE user_id = $1",
    [userId],
  );

  // Accounts
  await manager.query("DELETE FROM accounts WHERE user_id = $1", [userId]);

  // Institutions (accounts reference these via institution_id; deleted after
  // accounts so no rows still point at them)
  await manager.query("DELETE FROM institutions WHERE user_id = $1", [userId]);

  // Categories
  await manager.query("DELETE FROM categories WHERE user_id = $1", [userId]);

  // Calendar day notes: no child rows and no foreign key but `users`, so the
  // order relative to the rest does not matter -- only that it is cleared at
  // all, or the insert's ON CONFLICT DO NOTHING would keep the destination's
  // note and silently drop the archive's.
  await manager.query("DELETE FROM calendar_day_notes WHERE user_id = $1", [
    userId,
  ]);

  // User preferences and auto-backup settings
  await manager.query("DELETE FROM auto_backup_settings WHERE user_id = $1", [
    userId,
  ]);
  await manager.query(
    "DELETE FROM user_currency_preferences WHERE user_id = $1",
    [userId],
  );
  await manager.query("DELETE FROM user_preferences WHERE user_id = $1", [
    userId,
  ]);

  // User-created currencies, but only ones nothing else still points at.
  //
  // Columns across most of the financial tables reference `currencies(code)`.
  // Deleting a row any of them still holds aborts the whole restore with
  // "violates foreign key constraint" -- except `user_currency_preferences`,
  // whose FK cascades and would silently remove another user's activation.
  //
  // This user's own accounts/transactions/securities/scheduled/budgets/prefs
  // are already deleted above, so a surviving reference is another user's (or
  // the global `exchange_rates`, which a restore never clears and which gets a
  // row for every currency the FX backfill has ever seen). That is exactly
  // what must block the delete.
  //
  // The `NOT EXISTS` chain this replaced listed every column but ran
  // inside this restore's transaction, where RLS filters every table to the
  // restoring user -- so the clauses looking for *other* users' rows could not
  // see them, and the cascade fired. `currency_code_in_use_globally`
  // (migration 136) is SECURITY DEFINER, so the answer is global, and it runs
  // in this transaction, so it stays atomic with the delete.
  await manager.query(
    `DELETE FROM currencies c
      WHERE c.created_by_user_id = $1
        AND NOT currency_code_in_use_globally(c.code)`,
    [userId],
  );
}
