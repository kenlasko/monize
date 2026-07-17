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

## Honest limits

This protects against **casual/opportunistic exposure** (someone browsing a
GitHub issue), not a determined party who already knows the user. Dates,
frequencies and structure are preserved by design so bugs still reproduce, and
those can re-identify a person regardless of `M`. Optional password encryption
is offered for the file; the UI states the de-identification caveat plainly.

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
- `support-backup-scope.ts` — optional account scoping with referential
  closure; dimension tables (categories, payees, tags, securities, …) are kept
  whole while account-specific tables are trimmed and dangling account FKs are
  reset so the file still restores.

Endpoints (`POST /backup/support-export`, `POST /backup/support-export/preview`)
and the **Create support backup** modal live under Settings → Help & Support.
