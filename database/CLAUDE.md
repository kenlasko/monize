# Database Directory

## Overview
Contains the PostgreSQL schema definition and incremental migration scripts for the monize database.

## Files
- `schema.sql` - Full database schema (used for fresh installs). Must be kept in sync with all migrations.
- `migrations/` - Incremental SQL migration files applied to existing databases.

## Development Database Connection
Credentials are in the root `.env` file (`POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`).

### Running a migration
```bash
PGPASSWORD=$POSTGRES_PASSWORD psql -h localhost -U $POSTGRES_USER -d $POSTGRES_DB -f database/migrations/<filename>.sql
```

## Creating a New Migration

1. **Create the migration file** in `database/migrations/` with the next sequential number prefix:
   - Current latest: `017_add_week_starts_on.sql`
   - Next file: `018_<descriptive_name>.sql`
   - Use `IF NOT EXISTS` / `IF EXISTS` to make migrations idempotent

2. **Update `schema.sql`** to reflect the same change (so fresh installs match migrated databases)

3. **Update the backend TypeORM entity** if the migration modifies a table mapped to an entity. Column names in the database use `snake_case`, entity properties use `camelCase`, with the mapping specified via `@Column({ name: 'snake_case_name' })`.

4. **Update the backend DTO** if the field should be user-editable (add validation decorators from `class-validator`)

5. **Update frontend types** in `frontend/src/types/` to match

6. **Run the migration** on the development database using the psql command above

## Migration File Conventions
- Numbered prefix for ordering: `NNN_description.sql` (e.g., `017_add_week_starts_on.sql`)
- Use `ADD COLUMN IF NOT EXISTS` for column additions
- Use `CREATE TABLE IF NOT EXISTS` for new tables
- Use `CREATE INDEX IF NOT EXISTS` for new indexes
- Include a comment at the top describing the change
- Keep migrations small and focused on a single change

## Key Tables
- `users` - User accounts and authentication
- `user_preferences` - Per-user settings (currency, date format, theme, etc.)
- `accounts` - Financial accounts (chequing, savings, credit, investment, etc.)
- `transactions` - Financial transactions linked to accounts
- `categories` - Transaction categories (hierarchical via `parent_id`)
- `payees` - Transaction payees
- `budgets` / `budget_categories` - Budget definitions and category allocations
- `scheduled_transactions` / `scheduled_transaction_splits` - Recurring transactions
- `securities` / `investment_transactions` / `investment_holdings` - Investment tracking
- `ai_provider_configs` / `ai_conversations` / `ai_messages` - AI assistant
- `custom_reports` - Saved report configurations
