/**
 * What a backup reads, in the order it is read, plus the tables it deliberately
 * does not read.
 *
 * Extracted from `BackupService` so the list and its rationale live in one file
 * rather than in the middle of a 2,600-line class. `export-driver-values.spec.ts`
 * parses this file (see the markers it looks for) to prove every BYTEA column is
 * selected through `encode(col, 'base64')`.
 */

import {
  BLOB_EXPORT_BATCH_ROWS,
  ExportReader,
  ExportRead,
} from "./export-cursor";

export { ExportRead };

/**
 * Rows a table contributes that its query cannot return, produced one at a time.
 *
 * There is exactly one: `attachment_blobs` carries the `database` provider's
 * bytes as rows, and the `local`/`s3` providers' bytes have to be read from the
 * object store and appended. It is an async **generator** rather than an array
 * builder because that is the difference the memory ceiling turns on -- the old
 * `augment` returned every carried object in one array, so thirty 10 MiB
 * receipts were ~400 MiB of base64 resident before a byte could be written
 * (issue #1070). Yielding one row at a time lets the writer hand each object to
 * gzip and drop it.
 *
 * Supplied by `BackupExportService`, which owns the storage provider; the query
 * list stays free of it.
 */
export type ExportRowSource = (
  reader: ExportReader,
) => AsyncIterable<Record<string, unknown>>;

/**
 * One table in the export.
 *
 * `batchRows` is how many rows the cursor fetches at once. It is left unset for
 * every table whose rows are small and set to `BLOB_EXPORT_BATCH_ROWS` for the
 * one whose single row can be megabytes.
 */
export interface ExportTableQuery {
  key: string;
  sql: string;
  batchRows?: number;
  trailingRows?: ExportRowSource;
  /**
   * Rewrites one row on its way into the document, row at a time so the memory
   * ceiling is unchanged. Two tables use it, for one reason:
   * `ai_provider_configs` and `payee_lookup_settings` each hold an
   * `api_key_enc` under this instance's `ENCRYPTION_KEY`, which is server
   * configuration and never travels in the file, so the key is swapped for its
   * plaintext here (`ai-provider-key-transport.ts`) and re-encrypted by the
   * restore. Both columns are named `api_key_enc` deliberately: the transport
   * is keyed on that name, so a third such table gets this treatment by
   * spelling its column the same way.
   *
   * Applied by both `exportJsonChunks` and `collectExportTables`, so the
   * streamed artifact and the support backup's in-memory map cannot disagree
   * about what a backup contains.
   */
  transformRow?: (row: Record<string, unknown>) => Record<string, unknown>;
}

/**
 * Every exported table whose rows carry an `api_key_enc`, derived from the
 * export itself rather than restated.
 *
 * A table gets the key transport by carrying `transformRow`, so asking which
 * queries carry it *is* the question -- and the restore, which has to
 * re-encrypt exactly those tables, can no longer disagree with the export
 * about which they are. Restated as a literal it silently could:
 * `payee_lookup_settings` was added to the export and to the restore's list by
 * hand, and deleting it from either one broke nothing that any test could see.
 *
 * The marker is identity-compared, so this reports the tables that *would*
 * receive the transform, independently of what any real one does.
 */
export function keyBearingExportTables(): readonly string[] {
  const marker = (row: Record<string, unknown>) => row;
  return buildExportTableQueries(async function* () {}, marker)
    .filter((query) => query.transformRow === marker)
    .map((query) => query.key);
}

/**
 * User-owned tables that are deliberately NOT part of a backup, each with the
 * reason. The coverage guard test asserts every table in the database is either
 * exported (see `BackupExportService.getBackedUpTableNames`) or listed here, so adding a new entity
 * forces an explicit decision instead of silently dropping data on restore.
 */
export const INTENTIONALLY_EXCLUDED_TABLES: ReadonlySet<string> = new Set([
  "users", // the account row itself; a restore targets an existing user
  "action_history", // undo/redo log, wiped on restore (not undoable to prior state)
  "ai_insights", // regenerable AI cache
  "ai_usage_logs", // usage telemetry, not user content
  // The OPERATOR's Google Places counter. Deliberately not exported while
  // `payee_lookup_usage` beside it is: this row has no `user_id`, it counts a
  // key configured by GOOGLE_PLACES_API_KEY (deployment configuration, which
  // no backup carries either), and every user on the instance spends it. A
  // per-user archive writing it would let one user's restore overwrite a
  // counter another user's lookups are still spending.
  "google_places_instance_usage",
  "exchange_rates", // global shared reference data, not per-user
  "market_index_prices", // global market reference data, refetched from the provider
  "market_index_sync", // provider fetch bookkeeping for the above
  "provider_health", // deployment-wide provider availability + alert bookkeeping
  "account_delegates", // cross-user sharing relationship
  "account_delegate_grants", // cross-user sharing relationship
  "delegate_account_favourites", // cross-user sharing state
  "delegate_net_worth_exclusions", // cross-user sharing state (joint accounts)
  "emergency_access_contacts", // cross-user emergency-access config
  "emergency_access_settings", // cross-user emergency-access config
  "oauth_payloads", // transient OIDC state
  "oidc_step_up_claims", // spent step-up proofs; 5-minute lifetime, auth bookkeeping
  // Import working state, not user content: the staged bytes are a decrypted
  // upload with a 24 h TTL, and a job row describes one in-flight import. Both
  // are meaningless after the fact, and the staged file would multiply a
  // backup's size by the size of whatever was last uploaded.
  "import_staged_files",
  "import_jobs",
  "personal_access_tokens", // auth credentials -- never exported
  "refresh_tokens", // auth session tokens -- never exported
  "trusted_devices", // 2FA device registrations -- never exported
  "schema_migrations", // migration bookkeeping (no entity; system table)
  // Cross-replica coordination state for *this* deployment, not user content.
  // A lease describes a worker that is running right now, and a delivery record
  // says an email left this instance's SMTP -- restored elsewhere it would
  // suppress a reminder that was never sent to that account, which is the one
  // failure this table exists to prevent.
  "job_claims",
  // Reclamation bookkeeping for objects in *this* instance's storage provider,
  // keyed by (provider, storage_key). Those keys name nothing on the machine a
  // backup is restored onto, and a future sweeper reading a restored row could
  // delete a live object whose key happens to collide.
  "attachment_blob_tombstones",
  // Push transport state for *this* instance, and the one table pair where
  // exporting it would be actively dangerous. A subscription names a browser on
  // one machine talking to one origin, encrypted under this deployment's VAPID
  // key pair -- restored elsewhere it either cannot be delivered to at all or,
  // worse, can: a production backup restored into a test instance would hand
  // that instance the right to push to real phones. Devices re-subscribe, which
  // costs one click and is the only way the new instance gets a key the push
  // service will accept.
  "push_subscriptions",
  // The key pair itself: an installation secret, not user content. It shares
  // the backup/restore lifecycle of ENCRYPTION_KEY rather than of a ledger.
  "push_instance_config",
  "push_chart_artifacts",
  // Instance-bound delivery ledger for this deployment's egress; not portable
  // user data. Same category as push_subscriptions above: a row names an object
  // key in a bucket this instance uploads to, and restored elsewhere it would
  // claim a copy the new instance never made.
  "backup_offsite_uploads",
  // Egress destination credentials encrypted under this instance's
  // ENCRYPTION_KEY; re-entered on a new instance, never carried in an artifact.
  // Unlike ai_provider_configs, these are not decrypted into the file: an
  // artifact that can be mailed to its own destination must not carry the
  // credential for that destination.
  "backup_offsite_settings",
]);

export function buildExportTableQueries(
  externalAttachmentRows: ExportRowSource,
  /**
   * Supplied by `BackupExportService`, which owns the encryption service. Left
   * optional so a spec exercising the SQL alone does not have to build one; the
   * row then travels exactly as the database returned it, which is the
   * pre-transport behaviour.
   */
  aiProviderKeyTransform?: (
    row: Record<string, unknown>,
  ) => Record<string, unknown>,
): ExportTableQuery[] {
  return [
    {
      // Every currency this user's data depends on, not just the ones they
      // created. Currencies are shared: any user may activate a code another
      // user defined, so `created_by_user_id = $1` exported the references
      // without the definition. On a fresh instance the restore then
      // synthesised name, symbol and decimal places from a fallback -- `PTS /
      // Family Points / * / 0 decimals` came back as `PTS / PTS / PTS / 2
      // decimals`, so a balance of 7 rendered `PTS 7.00` instead of `*7`. The
      // amounts were right; what they meant was not.
      //
      // Canonical currencies are included too. Their metadata usually resolves
      // from the curated catalog anyway, but exporting the row costs one line
      // and makes the restore reproduce what the source instance actually had
      // rather than what this instance would guess. `ON CONFLICT (code) DO
      // NOTHING` means an existing row on the target always wins, so this can
      // never overwrite a definition the target already holds.
      //
      // The referencing columns live in `currency_codes_referenced_by_user`
      // (migration 137) rather than being spelled out here: this list has
      // drifted before, and currency-references.spec.ts checks the function
      // against the schema.
      key: "currencies",
      sql: `SELECT * FROM currencies
             WHERE created_by_user_id = $1
                OR code IN (SELECT currency_codes_referenced_by_user($1))
             ORDER BY code`,
    },
    {
      key: "user_preferences",
      sql: "SELECT * FROM user_preferences WHERE user_id = $1",
    },
    {
      key: "user_currency_preferences",
      sql: "SELECT * FROM user_currency_preferences WHERE user_id = $1",
    },
    {
      key: "calendar_day_notes",
      sql: "SELECT * FROM calendar_day_notes WHERE user_id = $1 ORDER BY note_date",
    },
    {
      key: "categories",
      sql: "SELECT * FROM categories WHERE user_id = $1 ORDER BY parent_id NULLS FIRST, name",
    },
    {
      // Columns are listed rather than `SELECT *` because logo_data is BYTEA:
      // the driver returns a Buffer, which JSON.stringify turns into
      // {"type":"Buffer",...} and the restore then feeds to decode(...,
      // 'base64'). Base64-encoding it here is what makes the round trip work,
      // exactly as for institutions below.
      key: "payees",
      sql: `SELECT id, user_id, name, default_category_id, notes, website,
                   address, email, phone,
                   contact_lookup_at, contact_lookup_source,
                   encode(logo_data, 'base64') AS logo_data,
                   logo_content_type, has_logo, logo_fetched_at,
                   is_active, created_at
            FROM payees WHERE user_id = $1 ORDER BY name`,
    },
    {
      key: "payee_aliases",
      sql: "SELECT * FROM payee_aliases WHERE user_id = $1",
    },
    {
      // Institutions must be exported (and restored) before accounts because
      // accounts.institution_id has an FK to institutions(id). The logo_data
      // BYTEA column is base64-encoded so it survives JSON serialization;
      // insertRows decodes it back to bytea on restore.
      key: "institutions",
      sql: `SELECT id, user_id, name, website, country,
                   encode(logo_data, 'base64') AS logo_data,
                   logo_content_type, has_logo, logo_fetched_at,
                   created_at, updated_at
            FROM institutions WHERE user_id = $1 ORDER BY name`,
    },
    {
      key: "accounts",
      sql: "SELECT * FROM accounts WHERE user_id = $1 ORDER BY name",
    },
    {
      key: "tags",
      sql: "SELECT * FROM tags WHERE user_id = $1 ORDER BY name",
    },
    {
      key: "transactions",
      sql: "SELECT * FROM transactions WHERE user_id = $1 ORDER BY transaction_date, created_at",
    },
    {
      key: "transaction_splits",
      sql: `SELECT ts.* FROM transaction_splits ts
            JOIN transactions t ON ts.transaction_id = t.id
            WHERE t.user_id = $1`,
    },
    {
      // Attachment metadata. Restored after transactions (FK) and before
      // attachment_blobs (which references transaction_attachments).
      key: "transaction_attachments",
      sql: "SELECT * FROM transaction_attachments WHERE user_id = $1",
    },
    {
      // Attachment bytes, base64-encoded so they survive JSON; insertRows
      // decodes them back to bytea on restore (auto-detected via
      // information_schema).
      //
      // The query covers the `database` provider, whose bytes are in this
      // table. `trailingRows` adds the `local` and `s3` providers', which are
      // not -- see `BackupExportService.externalAttachmentRows` for why they
      // have to travel too.
      //
      // One row per fetch: each row is a whole base64-encoded object, so the
      // batch size is the number of attachments resident at once.
      key: "attachment_blobs",
      sql: `SELECT ab.attachment_id, encode(ab.data, 'base64') AS data
            FROM attachment_blobs ab
            JOIN transaction_attachments ta ON ab.attachment_id = ta.id
            WHERE ta.user_id = $1`,
      batchRows: BLOB_EXPORT_BATCH_ROWS,
      trailingRows: externalAttachmentRows,
    },
    {
      key: "transaction_tags",
      sql: `SELECT tt.* FROM transaction_tags tt
            JOIN transactions t ON tt.transaction_id = t.id
            WHERE t.user_id = $1`,
    },
    {
      key: "transaction_split_tags",
      sql: `SELECT tst.* FROM transaction_split_tags tst
            JOIN transaction_splits ts ON tst.transaction_split_id = ts.id
            JOIN transactions t ON ts.transaction_id = t.id
            WHERE t.user_id = $1`,
    },
    {
      key: "scheduled_transactions",
      sql: "SELECT * FROM scheduled_transactions WHERE user_id = $1",
    },
    {
      key: "scheduled_transaction_splits",
      sql: `SELECT sts.* FROM scheduled_transaction_splits sts
            JOIN scheduled_transactions st ON sts.scheduled_transaction_id = st.id
            WHERE st.user_id = $1`,
    },
    {
      key: "scheduled_transaction_overrides",
      sql: `SELECT sto.* FROM scheduled_transaction_overrides sto
            JOIN scheduled_transactions st ON sto.scheduled_transaction_id = st.id
            WHERE st.user_id = $1`,
    },
    {
      // Exported, unlike the other new coordination tables: this one is the
      // durable record that a given occurrence was posted, and the unique key
      // on (scheduled_transaction_id, original_due_date) is what stops the same
      // bill being paid twice. Restored empty, that guard is gone for every
      // occurrence already in the restored ledger, and a manual post of one of
      // them would duplicate a financial transaction.
      key: "scheduled_transaction_postings",
      sql: `SELECT stp.* FROM scheduled_transaction_postings stp
            JOIN scheduled_transactions st ON stp.scheduled_transaction_id = st.id
            WHERE st.user_id = $1`,
    },
    {
      key: "scheduled_transaction_split_tags",
      sql: `SELECT stst.* FROM scheduled_transaction_split_tags stst
            JOIN scheduled_transaction_splits sts ON stst.scheduled_transaction_split_id = sts.id
            JOIN scheduled_transactions st ON sts.scheduled_transaction_id = st.id
            WHERE st.user_id = $1`,
    },
    { key: "securities", sql: "SELECT * FROM securities WHERE user_id = $1" },
    {
      key: "security_prices",
      sql: `SELECT sp.* FROM security_prices sp
            JOIN securities s ON sp.security_id = s.id
            WHERE s.user_id = $1`,
    },
    {
      key: "security_documents",
      sql: "SELECT * FROM security_documents WHERE user_id = $1",
    },
    {
      key: "holdings",
      sql: `SELECT h.* FROM holdings h
            JOIN accounts a ON h.account_id = a.id
            WHERE a.user_id = $1`,
    },
    // includes VOID rows: records read -- a backup keeps every row.
    {
      key: "investment_transactions",
      sql: "SELECT * FROM investment_transactions WHERE user_id = $1",
    },
    {
      // Join tags between securities and tags. Owned transitively via the
      // securities/tags rows, so scope by the security's owner.
      key: "security_tags",
      sql: `SELECT st.* FROM security_tags st
            JOIN securities s ON st.security_id = s.id
            WHERE s.user_id = $1`,
    },
    {
      key: "loan_rate_changes",
      sql: "SELECT * FROM loan_rate_changes WHERE user_id = $1",
    },
    {
      key: "loan_scenarios",
      sql: "SELECT * FROM loan_scenarios WHERE user_id = $1",
    },
    { key: "budgets", sql: "SELECT * FROM budgets WHERE user_id = $1" },
    {
      key: "budget_categories",
      sql: `SELECT bc.* FROM budget_categories bc
            JOIN budgets b ON bc.budget_id = b.id
            WHERE b.user_id = $1`,
    },
    {
      key: "budget_periods",
      sql: `SELECT bp.* FROM budget_periods bp
            JOIN budgets b ON bp.budget_id = b.id
            WHERE b.user_id = $1`,
    },
    {
      key: "budget_period_categories",
      sql: `SELECT bpc.* FROM budget_period_categories bpc
            JOIN budget_periods bp ON bpc.budget_period_id = bp.id
            JOIN budgets b ON bp.budget_id = b.id
            WHERE b.user_id = $1`,
    },
    {
      key: "notifications",
      sql: "SELECT * FROM notifications WHERE user_id = $1",
    },
    {
      key: "notification_preferences",
      sql: "SELECT * FROM notification_preferences WHERE user_id = $1",
    },
    {
      key: "notification_reminders",
      sql: "SELECT * FROM notification_reminders WHERE user_id = $1",
    },
    {
      key: "notification_portfolio_state",
      sql: "SELECT * FROM notification_portfolio_state WHERE user_id = $1",
    },
    {
      key: "custom_reports",
      sql: "SELECT * FROM custom_reports WHERE user_id = $1",
    },
    {
      key: "investment_reports",
      sql: "SELECT * FROM investment_reports WHERE user_id = $1",
    },
    {
      key: "import_column_mappings",
      sql: "SELECT * FROM import_column_mappings WHERE user_id = $1",
    },
    {
      key: "monthly_account_balances",
      sql: "SELECT * FROM monthly_account_balances WHERE user_id = $1",
    },
    {
      key: "auto_backup_settings",
      sql: "SELECT * FROM auto_backup_settings WHERE user_id = $1",
    },
    {
      key: "ai_provider_configs",
      sql: "SELECT * FROM ai_provider_configs WHERE user_id = $1",
      // `api_key_enc` is ciphertext under this instance's ENCRYPTION_KEY,
      // which is not in the backup. Exported verbatim it restores onto another
      // instance populated and unreadable, so the key is decrypted here and
      // re-encrypted by the restore. See ai-provider-key-transport.ts for the
      // contract, including what the artifact then contains in plaintext.
      transformRow: aiProviderKeyTransform,
    },
    {
      key: "payee_lookup_settings",
      sql: "SELECT * FROM payee_lookup_settings WHERE user_id = $1",
      // Same contract as ai_provider_configs above, and the same column name:
      // api_key_enc is ciphertext under this instance's ENCRYPTION_KEY, so it
      // travels decrypted and is re-encrypted by the restore.
      transformRow: aiProviderKeyTransform,
    },
    {
      // The user's own Google Places counter, so a month's spend survives a
      // move to another machine -- the key is the same key, and Google's
      // free allowance is counted against it, not against the server.
      //
      // The restore deliberately does NOT clear this table first, and the
      // insert's ON CONFLICT DO NOTHING is what makes that correct: a machine
      // with no row (the migration this exists for) takes the archive's count,
      // while a machine that already has one keeps its own. The live count is
      // never lowered, because under-counting a quota is the direction that
      // reaches a bill -- and the only way an archive's count can be the
      // higher of the two is that the live one was lost, which is the case
      // where there is no row to conflict with.
      key: "payee_lookup_usage",
      sql: "SELECT * FROM payee_lookup_usage WHERE user_id = $1",
    },
    {
      key: "monte_carlo_scenarios",
      sql: "SELECT * FROM monte_carlo_scenarios WHERE user_id = $1",
    },
    {
      key: "monte_carlo_cash_flows",
      sql: `SELECT mccf.* FROM monte_carlo_cash_flows mccf
            JOIN monte_carlo_scenarios mcs ON mccf.scenario_id = mcs.id
            WHERE mcs.user_id = $1`,
    },
    {
      key: "gem_strategies",
      sql: "SELECT * FROM gem_strategies WHERE user_id = $1",
    },
    {
      key: "gem_strategy_accounts",
      sql: "SELECT * FROM gem_strategy_accounts WHERE user_id = $1",
    },
    {
      key: "gem_strategy_assets",
      sql: "SELECT * FROM gem_strategy_assets WHERE user_id = $1",
    },
    {
      key: "gem_strategy_signals",
      sql: "SELECT * FROM gem_strategy_signals WHERE user_id = $1",
    },
  ];
}
