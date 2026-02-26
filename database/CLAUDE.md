# Database Directory

## Overview
Contains the PostgreSQL schema definition and incremental migration scripts for the monize database.

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

### Running a migration manually (optional — migrations run automatically on startup)
```bash
PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U $POSTGRES_USER -d $POSTGRES_DB -f database/migrations/<filename>.sql
```

## Creating a New Migration

1. **Create the migration file** in `database/migrations/` with the next sequential number prefix:
   - Current latest: `018_user_currency_preferences.sql`
   - Next file: `019_<descriptive_name>.sql`
   - Use `IF NOT EXISTS` / `IF EXISTS` to make migrations idempotent

2. **Update `schema.sql`** to reflect the same change (so fresh installs match migrated databases)

3. **Update the backend TypeORM entity** if the migration modifies a table mapped to an entity. Column names in the database use `snake_case`, entity properties use `camelCase`, with the mapping specified via `@Column({ name: 'snake_case_name' })`.

4. **Update the backend DTO** if the field should be user-editable (add validation decorators from `class-validator`)

5. **Update frontend types** in `frontend/src/types/` to match

6. **Restart the backend** — migrations will be applied automatically on startup

## Migration File Conventions
- Numbered prefix for ordering: `NNN_description.sql` (e.g., `018_user_currency_preferences.sql`)
- Use `ADD COLUMN IF NOT EXISTS` for column additions
- Use `CREATE TABLE IF NOT EXISTS` for new tables
- Use `CREATE INDEX IF NOT EXISTS` for new indexes
- Include a comment at the top describing the change
- Keep migrations small and focused on a single change
- Migrations must be idempotent (safe to run multiple times)

## Key Tables
- `schema_migrations` - Tracks which migration files have been applied
- `users` - User accounts and authentication
- `user_preferences` - Per-user settings (currency, date format, theme, etc.)
- `user_currency_preferences` - Per-user currency visibility and active state
- `accounts` - Financial accounts (chequing, savings, credit, investment, etc.)
- `transactions` - Financial transactions linked to accounts
- `categories` - Transaction categories (hierarchical via `parent_id`)
- `payees` - Transaction payees
- `budgets` / `budget_categories` - Budget definitions and category allocations
- `scheduled_transactions` / `scheduled_transaction_splits` - Recurring transactions
- `securities` / `investment_transactions` / `investment_holdings` - Investment tracking
- `ai_provider_configs` / `ai_conversations` / `ai_messages` - AI assistant
- `custom_reports` - Saved report configurations
