/**
 * Tables never written to a support backup regardless of section selection.
 * `ai_provider_configs` holds encrypted API keys and endpoint URLs with zero
 * diagnostic value for a finance bug, so it is dropped wholesale, and
 * `payee_lookup_settings` holds a Google Places key for the same reason. The two
 * attachment tables carry user-uploaded receipts/documents: `attachment_blobs`
 * is raw file bytes (a NOT NULL BYTEA with no useful de-identified form) and
 * `transaction_attachments` is their metadata (filenames can embed PII), so
 * both are omitted from the de-identified support backup. Their columns are
 * intentionally absent from RULES in support-backup-rules.ts; the golden test
 * skips them.
 */
export const ALWAYS_EXCLUDED_TABLES: ReadonlySet<string> = new Set([
  "shared_integrations", // Private pre-link snapshots are not suitable for a support artifact.
  "shared_postings",
  "shared_ledger_links",
  "ai_provider_configs",
  "payee_lookup_settings",
  "transaction_attachments",
  "attachment_blobs",
  "push_chart_artifacts",
]);
