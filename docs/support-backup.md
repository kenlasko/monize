# Support (de-identified) backup

A **support backup** is a de-identified copy of a user's data they can attach to
a GitHub issue so a maintainer can reproduce a bug without seeing real names or
amounts. It is a normal Monize backup file (`version: 1`) and restores through
the ordinary restore flow into a throwaway instance — nothing new is needed to
open it.

Discussion: https://github.com/kenlasko/monize/discussions/896

## What it does

Starting from the same rows the normal export produces, the support backup:

- **Masks** free-text names, keeping the first and last two characters
  (`Biedronka` → `Bi*****ka`; four characters or fewer are fully masked), so a
  record can still be discussed without revealing the real name.
- **Drops** the highest-risk free text and secrets entirely: descriptions,
  notes, memos, reference numbers, account numbers, institution logos/websites,
  the AI provider configs table (encrypted API keys), and the last-client
  timezone. Dropping descriptions also removes real figures banks paste into
  them (e.g. `ODSETKI: 388,14`).
- **Scales** every private amount by a single multiplier `M` (a non-integer > 1)
  while leaving **public reference values untouched** — exchange rates, security
  prices, per-unit costs and interest rates. Scaling a private amount but not a
  linked public value would let anyone recover `M` by division, so share
  quantities are scaled in lockstep with their totals.
- **Reconciles** derived money from the scaled values: a split transaction's
  amount becomes the exact sum of its scaled splits, and each account's current
  balance becomes its scaled opening balance plus the sum of its scaled
  transactions — so nothing drifts by a rounding cent.
- **Remaps** every identifier (and the user's own id) to fresh UUIDs, so a
  shared file can't be correlated with the account or with another shared file.
- **Keeps masked values unique** on every UNIQUE column: masking is not
  injective (short values collapse to all-asterisks, e.g. tickers `AAPL`/`MSFT`
  both become `****`, and any two values sharing their first/last two characters
  and length coincide), so a collision would make `INSERT ... ON CONFLICT DO
  NOTHING` silently drop the second row on restore and orphan its children (a
  dropped payee leaves its NOT NULL `payee_aliases` dangling). Colliding masked
  values get a ` (n)` suffix so every row still restores.
- **Excludes the securities price history by default**: a full OHLCV series
  matches public market data exactly and would identify a masked ticker. An
  explicit opt-in checkbox includes it for price/valuation bugs.
- **Always encrypts** the file: the modal pre-fills a random password (editable,
  regenerable) and the export refuses to run without one -- a support backup is
  made to leave the user's machine, so it never ships in the clear. Share the
  password through a separate channel.
- Supports an optional **date range**: history outside the window is trimmed
  and each account's opening balance is advanced by the removed transactions,
  so the trimmed file still reconciles to the true balance.
- Runs a **referential-integrity scrub** after any trimming (account scope,
  date range, disabled sections): a declarative map of every FK between
  exported tables nulls or drops each dangling reference, so a trimmed file
  always restores. Id arrays outside FK constraints (Monte Carlo account lists,
  report filters) are filtered to accounts present in the file, and the
  free-form dashboard widget config is reset under account scoping, so no
  excluded account's identifier survives un-remapped.

## Honest limits

This protects against **casual/opportunistic exposure** (someone browsing a
GitHub issue), not a determined party who already knows the user. Dates,
frequencies and structure are preserved by design so bugs still reproduce, and
those can re-identify a person regardless of `M`. The file is always
password-encrypted; the UI states the de-identification caveat plainly.

## Implementation

Backend, under `backend/src/backup/support-backup/`:

- `support-backup-rules.ts` — the per-column rule registry. It is an
  **allowlist**: a column with no rule is dropped, and the golden test
  (`test/integration/support-backup.integration.spec.ts`) fails when the live
  schema gains a column the registry does not classify, so a future migration
  cannot silently start leaking a field. JSONB blobs are classified per-key by
  handlers in `support-backup-jsonb.ts`, which are themselves allowlists.
- `support-backup.service.ts` — the engine: section filtering, rule application,
  reconciliation and id remap. It holds the whole export in memory (like the
  existing encrypted path) because reconciliation needs every table at once, so
  it does not stream.
- `support-backup-scope.ts` — optional account scoping and date-range trimming.
  Dimension tables (categories, payees, tags, securities, …) are kept whole
  while account-specific tables are trimmed; a date range also advances each
  account's opening balance by the removed transactions so the file still
  reconciles.
- `support-backup-integrity.ts` — the referential-integrity scrub run after any
  trimming: a declarative FK map (`REFS`) nulls or drops every reference whose
  target was removed, so a scoped/date-ranged/section-trimmed file always
  restores. An integration test asserts `REFS` covers every foreign key between
  exported tables (`information_schema`), the same completeness guard the golden
  test gives the column rules — so a future migration can't add an FK the scrub
  silently ignores. The scrub is skipped for a full untrimmed export (nothing
  can dangle). The same file also holds `dedupeMaskedText`, which restores
  uniqueness on masked UNIQUE columns (see above); unlike the scrub it runs on
  every export, since masking collisions are independent of trimming, and an
  integration test asserts its map covers every UNIQUE index over a masked
  column.

A short-lived per-user cache holds the raw export so a preview followed by
generate collects the database once, and the preview obfuscates only the rows
it displays (plus each shown account's ledger, to keep balances exact).

Endpoints (`POST /backup/support-export`, `POST /backup/support-export/preview`)
and the **Create support backup** modal live under Settings → Help & Support.
