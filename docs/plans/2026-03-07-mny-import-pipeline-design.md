# Microsoft Money Import Pipeline

Import data from a Microsoft Money `.mny` file into the monize PostgreSQL database.

## Pipeline

Three stages, orchestrated by `migration/migrate.sh`:

1. **Decrypt** -- sunriise JAR converts `.mny` to `.mdb` (downloaded automatically if missing)
2. **Extract** -- `mdb-export` (from `mdbtools`) reads each table as CSV
3. **Load** -- `migration/migrate.ts` transforms and inserts into Postgres via `pg`

Entry point: `cd migration && ./migrate.sh`

### Prerequisites

- Java runtime (for sunriise)
- `mdbtools` (`brew install mdbtools`)
- Node.js / npm
- Running Postgres with monize schema applied

### Configuration

`migration/.env`:

```
MONEY_FILE_PASSWORD=your-password-here
MIGRATION_USER_EMAIL=user@example.com
POSTGRES_DB=monize
POSTGRES_USER=monize_user
POSTGRES_PASSWORD=your-password
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
```

## Self-contained structure

Everything lives in `migration/` with its own `package.json` and `tsconfig.json`. No dependency on the NestJS backend or TypeORM. Dependencies: `pg`, `csv-parse`, `dotenv`.

## Idempotency

The script looks up the user by `MIGRATION_USER_EMAIL` and deletes all their existing data in FK-safe order before inserting. Safe to run repeatedly.

### Deletion order

1. `budget_period_categories`, `budget_periods`, `budget_alerts`, `budget_categories`, `budgets`
2. `scheduled_transaction_overrides`, `scheduled_transaction_splits`, `scheduled_transactions`
3. `investment_transactions`, `holdings`, `security_prices`, `securities`
4. `transaction_splits`, `transactions`
5. `monthly_account_balances`, `accounts`
6. `payees`, `categories`

Exchange rates (no `user_id`) are additive only -- inserted with `ON CONFLICT DO NOTHING`.

## Data mapping

### ID strategy

Money uses integer IDs, monize uses UUIDs. The script generates UUIDs for each entity and maintains in-memory `Map<number, string>` lookups to resolve foreign keys during import.

### Reference data

| Money table | Monize table | Notes |
|---|---|---|
| `CRNC` | `currencies` | Insert NZD if missing. Build `hcrnc` to ISO code map |
| `PAY` | `payees` | `hpay` to generated UUID |
| `CAT` | `categories` | Hierarchical, insert parents first (sort by `nLevel`). `is_income` defaults to `false` |
| `SEC` | `securities` | `hsec` to UUID. Currency from CRNC map |

### Accounts

| Money field | Monize field | Transformation |
|---|---|---|
| `at` (0-6) | `account_type` | 0=CHEQUING, 1=CREDIT_CARD, 2=CASH, 3=ASSET, 4=LOAN, 5=INVESTMENT, 6=MORTGAGE |
| `hcrnc` | `currency_code` | Via CRNC map |
| `amtOpen` | `opening_balance` | Direct decimal(20,4) |
| `szFull` | `name` | Strip "z " prefix for closed accounts |
| `fClosed` / "z " prefix | `is_closed` | Either flag triggers closure |
| `fFavorite` | `is_favourite` | Direct |
| `hacctRel` (for at=5) | `linked_account_id` | Investment-cash pairs. Cash side: `account_sub_type = 'INVESTMENT_CASH'`, investment side: `'INVESTMENT_BROKERAGE'` |

### Transactions

| Money field | Monize field | Notes |
|---|---|---|
| `amt` | `amount` | Direct decimal |
| `dt` | `transaction_date` | Parse MM/DD/YY with 70-year pivot |
| `lHpay` | `payee_id` | Via payee map |
| `hcat` | `category_id` | Via category map |
| `mMemo` | `description` | Direct |
| `szId` | `reference_number` | Direct |
| `cs` | `status` | 0=UNRECONCILED, 2=RECONCILED |
| `hacct` | `account_id` | Via account map |

Exclusions (from reference migration):
- Recurring bill instances (`frq != -1`)
- Auto-entered transactions (`grftt & 0x8000`)
- Voided transactions (`grftt & 0x80`)
- Bill template transactions (referenced by `BILL.lHtrn`)
- Orphaned transfer sides

### Splits

`TRN_SPLIT` to `transaction_splits`. Amount, category, memo from the split child's TRN row. `htrnParent` links to parent via transaction ID map.

### Transfers

`TRN_XFER` sets `is_transfer = true` and `linked_transaction_id` on both sides of the transfer pair.

### Investment transactions

`TRN_INV` to `investment_transactions`. Quantity sign determines action: positive=BUY, negative=SELL, zero=DIVIDEND. Price from `dPrice`, commission from `amtCmn`.

### Security prices

`SP` to `security_prices`. Deduplicated by `(security_id, price_date)`. Batch inserted.

### Exchange rates

`CRNC_EXCHG` to `exchange_rates`. Additive only (`ON CONFLICT DO NOTHING`).

### Scheduled transactions

`BILL` to `scheduled_transactions`. Frequency mapping: 0=ONCE, 1=DAILY, 2=WEEKLY, 3=MONTHLY, 4=YEARLY, 5=BIWEEKLY, 6=QUARTERLY, 7=YEARLY. Template TRN row provides amount, payee, category.

### Balance computation

After all transactions are inserted, compute `current_balance` for each imported account:
```sql
UPDATE accounts SET current_balance = opening_balance + COALESCE(
  (SELECT SUM(amount) FROM transactions WHERE account_id = accounts.id), 0
) WHERE user_id = $1
```

## Skipped data

- **Lots** (cost basis tracking) -- no equivalent table in monize
- **Holdings** -- not computed by the import; the application's holdings rebuild handles this

## Transaction wrapping

The entire import runs inside a single Postgres transaction. If any step fails, everything rolls back.

## Logging

Counts logged after each step. Data quality warnings (sub-penny amounts, missing FK references) go to stderr without halting the import.
