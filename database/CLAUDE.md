# Database Directory

## Overview
Contains the PostgreSQL schema definition and incremental migration scripts for the monize database.

A constraint here is usually the strongest available form of a system rule, so several entries in [`docs/system-invariants.md`](../docs/system-invariants.md) are enforced -- or unenforced -- by what is in `schema.sql`. `database/migrations/135_import_jobs_single_active.sql` is the model: a partial unique index doing what a read-then-insert in the service could not, with the reasoning in the migration's own header. See [`docs/concurrency-and-idempotency.md`](../docs/concurrency-and-idempotency.md) for when a constraint is the right mechanism, and note that a uniqueness constraint prevents duplicate *rows* and does nothing about a lost update to one.

## Files
- `schema.sql` - Full database schema (used for fresh installs). Must be kept in sync with all migrations.
- `migrations/` - Incremental SQL migration files. Applied automatically on app startup by `db-migrate`.

## Automatic Migrations

Migrations run automatically when the backend starts (both dev and production). The `db-migrate` script:

1. Creates a `schema_migrations` tracking table if it doesn't exist
2. Reads all `.sql` files from the `migrations/` directory
3. Compares against already-applied migrations in `schema_migrations`
4. Runs pending migrations in filename order, each wrapped in a transaction
5. Records each successful migration in `schema_migrations`

**Fresh installs:** `db-init` runs `schema.sql` first (which includes `schema_migrations`), then `db-migrate` runs all migrations. Since migrations use `IF NOT EXISTS`, they're no-ops on a fresh schema.

**Existing installs:** `db-init` skips (tables exist), then `db-migrate` applies only new migrations.

## Development Database Connection
Credentials are in the root `.env` file (`POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`).

## Creating a New Migration

1. **Create the migration file** in `database/migrations/` with the next sequential number prefix:
   - **Read the current max from the directory** (`ls database/migrations | tail`) — do not trust a
     number written in any document, including this one; they go stale (the RLS task list learned
     this three times).
   - **The numeric prefix must be unique** — `ls database/migrations | awk -F_ '{print $1}' | sort | uniq -d` should print nothing.
     Migrations are applied in filename order; duplicate prefixes (we have a few historical pairs at `022`, `068`, `075`, `116`, `117`) leave the apply order ambiguous and rely on alphabetical tie-breaking, which is brittle.
   - Use `IF NOT EXISTS` / `IF EXISTS` to make migrations idempotent

2. **Update `schema.sql`** to reflect the same change (so fresh installs match migrated databases)

3. **Update the backend TypeORM entity** if the migration modifies a table mapped to an entity. Column names in the database use `snake_case`, entity properties use `camelCase`, with the mapping specified via `@Column({ name: 'snake_case_name' })`.

4. **Update the backend DTO** if the field should be user-editable (add validation decorators from `class-validator`)

5. **Update frontend types** in `frontend/src/types/` to match

6. **Classify any new column in the support backup** if its table is exported —
   `backend/src/backup/support-backup/support-backup-rules.ts`. `RULES` is an
   allowlist, so an unclassified column is dropped from the output rather than
   leaked, but the golden test in
   `backend/test/integration/support-backup.integration.spec.ts` still fails
   until you classify it deliberately. That failure is the point: it forces a
   decision about a new field instead of letting a migration quietly change what
   a de-identified backup contains. Pick `keep` for structure, dates, enums,
   flags and FKs; `mask` for names; `drop` for free text, secrets, and anything
   that re-identifies a value masked elsewhere — a URL beside a masked name
   names the thing the mask hides, which is why `payees.website`,
   `securities.website` and `securities.msn_instrument_id` are all dropped. Use
   `const` instead of `drop` when the column is NOT NULL.

7. **Ship the table's RLS policy in the same migration** if the table is user-owned — see
   "Row-Level Security conventions" below. This is a hard convention, not a suggestion.

8. **Restart the backend** — migrations will be applied automatically on startup

## Row-Level Security conventions (hard rules)

Every user-owned table carries a row-level-security policy; the app emits per-transaction identity
GUCs through `withScopedDb` and the policies compare each row's owner against them (see
`docs/future-plans/row-level-security.md` and the runbook). Two rules bind every migration:

1. **A migration that creates a user-owned table ships its `CREATE POLICY` in the same file** —
   `117_mny_import_staging_and_jobs.sql` and `118_security_documents_rls.sql` are the worked
   examples. And because `123_rls_enable.sql` derives its `ENABLE ROW LEVEL SECURITY` targets from
   `pg_policies` *at the moment it runs*, any migration numbered **after** `123` must also ship its
   own `ALTER TABLE <t> ENABLE ROW LEVEL SECURITY;` — on a deployed database `123` has already been
   recorded in `schema_migrations` and will never run again, so a later policy without its own
   enable leaves that table as the single unprotected one under enforcement. (Enabling is inert
   while the app connects as the table owner, i.e. at `RLS_MODE=off`/`shadow`, so shipping it does
   not change behavior before the operator flips modes.)

   Every table must land in exactly one of **four buckets**, and the catalog-driven
   `backend/test/integration/rls-enforcement.integration.spec.ts` fails the moment a table is in
   none (or several):
   - **Direct**: the table has a `user_id` column → the uniform policy
     (`user_id = (SELECT app_current_user_id()) OR (SELECT app_bypass_rls())`), picked up with no
     spec change. Tables keyed by the *authenticated* user additionally OR in
     `user_id = (SELECT app_real_user_id())` — see `112_rls_policies_direct.sql` Group B.
   - **Owner-column**: a bespoke owner column (`owner_user_id`, `delegate_user_id`, `users.id`) →
     bespoke policy (`114_rls_policies_special.sql`), plus an entry in the spec's owner-column map.
   - **Indirect**: no owner column → an `EXISTS` back to the owning parent
     (`113_rls_policies_indirect.sql`), plus an entry in the spec's indirect map.
   - **Exempt**: global reference data with a documented rationale in the migration comment
     (`currencies`, `exchange_rates`, `oauth_payloads`, `schema_migrations`), plus the spec's
     exemption list.

   Keep the `(SELECT app_current_user_id())` initplan form — a bare function call relies on
   SQL-function inlining and evaluates per row on sequential scans.

2. **No migration may contain a role or grant statement.** `GRANT ... TO monize_app` (or any
   `CREATE/ALTER/DROP ROLE`) in a migration crash-loops every deployment where the role does not
   exist. The role and its grants are provisioned idempotently by db-init on every startup
   (`backend/src/common/db/app-role.ts`); on CNPG the role comes from the `Cluster` manifest
   (`managed.roles`) instead. New tables created by the owner get their grants automatically via
   `ALTER DEFAULT PRIVILEGES`.

## Migration File Conventions
- Numbered prefix for ordering: `NNN_description.sql` (e.g., `079_securities_is_favourite.sql`)
- Use `ADD COLUMN IF NOT EXISTS` for column additions
- Use `CREATE TABLE IF NOT EXISTS` for new tables
- Use `CREATE INDEX IF NOT EXISTS` for new indexes
- Include a comment at the top describing the change
- Keep migrations small and focused on a single change
- Migrations must be idempotent (safe to run multiple times)

## Idempotency is a CI gate

Every statement must be a no-op when re-applied to an up-to-date database --
a half-applied migration otherwise crash-loops the backend at startup. Two
checks enforce it, and `docs/database-migrations.md` holds the guard recipes
(`ADD CONSTRAINT` needs a preceding `DROP CONSTRAINT IF EXISTS`, `CREATE
TRIGGER` a `DROP TRIGGER IF EXISTS` or a `pg_trigger` `DO` block, `INSERT` an
`ON CONFLICT`, ...) plus the recovery runbook for a failed migration:

- `cd backend && npm run migration:lint` -- static guard check, run in the
  "Backend Lint & Type Check" job (`backend/scripts/migration-lint.mjs`).
- `scripts/verify-schema.sh` -- applies every migration on top of `schema.sql`
  **twice** and diffs the result, run in the "Schema vs Migrations Drift" job.

## Tables

`schema.sql` is the authoritative source. Use it (or the TypeORM entities under `backend/src/*/entities/`) to look up table and column definitions rather than maintaining a duplicate list here.
