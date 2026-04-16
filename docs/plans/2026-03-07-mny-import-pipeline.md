# Microsoft Money Import Pipeline — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Import data from a Microsoft Money `.mny` file into the monize PostgreSQL database.

**Architecture:** Self-contained `migration/` directory with its own `package.json`. Shell script orchestrates: sunriise decrypts `.mny` to `.mdb`, then a TypeScript script reads tables via `mdb-export` (mdbtools), transforms data, and inserts into Postgres via the `pg` driver. The entire import runs in a single DB transaction for atomicity.

**Tech Stack:** TypeScript, tsx, pg (node-postgres), csv-parse, mdbtools CLI, sunriise JAR

**Design doc:** `docs/plans/2026-03-07-mny-import-pipeline-design.md`

**Reference migration:** `/Users/mark/Projects/money/scripts/migrate.ts` — the source of truth for MS Money table structure, field names, exclusion rules, and transformation logic.

---

### Task 1: Scaffold the migration directory

**Files:**
- Create: `migration/package.json`
- Create: `migration/tsconfig.json`
- Create: `migration/.env.example`
- Create: `migration/.gitignore`

**Step 1: Create `migration/package.json`**

```json
{
  "name": "monize-migration",
  "version": "1.0.0",
  "private": true,
  "description": "Import Microsoft Money .mny files into monize",
  "scripts": {
    "migrate": "./migrate.sh"
  },
  "dependencies": {
    "csv-parse": "^5.6.0",
    "dotenv": "^16.4.7",
    "pg": "^8.13.1"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "@types/pg": "^8.11.10",
    "tsx": "^4.19.2",
    "typescript": "^5.7.0"
  }
}
```

**Step 2: Create `migration/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "commonjs",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "declaration": false,
    "sourceMap": false
  },
  "include": ["*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

**Step 3: Create `migration/.env.example`**

```bash
# Microsoft Money file password (the password you set in MS Money)
MONEY_FILE_PASSWORD=

# Email of the monize user to import data into (must already exist)
MIGRATION_USER_EMAIL=

# PostgreSQL connection (must match the monize database)
POSTGRES_DB=monize
POSTGRES_USER=monize_user
POSTGRES_PASSWORD=
POSTGRES_HOST=localhost
POSTGRES_PORT=5432
```

**Step 4: Create `migration/.gitignore`**

```
node_modules/
dist/
*.mdb
*.mny
*.jar
.env
```

**Step 5: Run `npm install`**

Run: `cd migration && npm install`

**Step 6: Commit**

```bash
git add migration/package.json migration/tsconfig.json migration/.env.example migration/.gitignore migration/package-lock.json
git commit -m "feat: scaffold migration directory with package.json and config"
```

---

### Task 2: Write the shell orchestration script

**Files:**
- Create: `migration/migrate.sh`

**Step 1: Create `migration/migrate.sh`**

```bash
#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")"

# Load .env
if [ -f .env ]; then
  set -a
  source .env
  set +a
fi

# Validate required vars
if [ -z "${MONEY_FILE_PASSWORD:-}" ]; then
  echo "Error: MONEY_FILE_PASSWORD is not set in .env" >&2
  exit 1
fi

if [ -z "${MIGRATION_USER_EMAIL:-}" ]; then
  echo "Error: MIGRATION_USER_EMAIL is not set in .env" >&2
  exit 1
fi

MNY_FILE="source.mny"
MDB_FILE="source.mdb"
JAR_FILE="sunriise-export-0.0.1-SNAPSHOT-exec.jar"

if [ ! -f "$MNY_FILE" ]; then
  echo "Error: $MNY_FILE not found. Copy your .mny file here and retry." >&2
  exit 1
fi

# Download sunriise JAR if missing
if [ ! -f "$JAR_FILE" ]; then
  echo "Downloading sunriise JAR..."
  curl -fSL -o "$JAR_FILE" \
    "https://github.com/hung-le/sunriise2-misc/blob/master/out/sunriise-export-0.0.1-SNAPSHOT-exec.jar?raw=true"
  echo "  Done."
fi

# Check prerequisites
if ! command -v java &> /dev/null; then
  echo "Error: java is required but not installed." >&2
  exit 1
fi

if ! command -v mdb-export &> /dev/null; then
  echo "Error: mdbtools is required but not installed. Install with: brew install mdbtools" >&2
  exit 1
fi

echo "Step 1: Decrypting .mny -> .mdb via sunriise..."
java -jar "$JAR_FILE" export.mdb "$MNY_FILE" "$MONEY_FILE_PASSWORD" "$MDB_FILE" 2>/dev/null
echo "  Done: $MDB_FILE"

echo ""
echo "Step 2: Running import..."
npx tsx migrate.ts
echo ""
echo "Import complete."
```

**Step 2: Make executable**

Run: `chmod +x migration/migrate.sh`

**Step 3: Commit**

```bash
git add migration/migrate.sh
git commit -m "feat: add shell orchestration script for migration pipeline"
```

---

### Task 3: Write transformation helpers

These are pure functions adapted from the reference migration. No DB access, fully testable in isolation.

**Files:**
- Create: `migration/transform.ts`

**Step 1: Create `migration/transform.ts`**

The file contains these exported functions, adapted from `/Users/mark/Projects/money/scripts/migrate.ts`:

- `readTable(mdbFile: string, table: string): Record<string, string>[]` — shells out to `mdb-export`, parses CSV
- `parseMnyDate(raw: string): string | null` — returns `YYYY-MM-DD` string (for Postgres DATE), not a JS Date. Handles the `01/00/00` null sentinel and 70-year pivot.
- `parseAccountType(at: number): string` — returns monize account_type enum string. Maps 0 to `'CHEQUING'` (not `'BANK'`).
- `parseFrequency(frq: number): string` — maps to monize scheduled_transactions frequency values: 0=ONCE, 1=DAILY, 2=WEEKLY, 3=MONTHLY, 4=YEARLY, 5=BIWEEKLY, 6=QUARTERLY, 7=YEARLY
- `buildCurrencyMap(crncRows: Record<string, string>[]): Map<string, string>` — maps `hcrnc` to ISO code from the CRNC table

Key differences from the reference migration:
- Returns `string` dates not `Date` objects (Postgres driver handles ISO strings)
- Account type 0 maps to `'CHEQUING'` not `'BANK'`
- Amounts stay as decimal strings, not converted to minor units (monize uses `decimal(20,4)`)
- No Prisma `Decimal` dependency — plain string/number arithmetic
- Sub-penny warning uses `console.warn` to stderr

**Step 2: Commit**

```bash
git add migration/transform.ts
git commit -m "feat: add transformation helpers for Money data"
```

---

### Task 4: Write the main migration script — setup, cleanup, and currencies

**Files:**
- Create: `migration/migrate.ts`

**Step 1: Create `migration/migrate.ts`**

This is the main entry point. Structure:

```typescript
import { Client } from 'pg'
import * as dotenv from 'dotenv'
import { readTable, parseMnyDate, parseAccountType, parseFrequency, buildCurrencyMap } from './transform'

dotenv.config()

const MDB_FILE = 'source.mdb'

async function main() {
  // 1. Connect to Postgres
  const client = new Client({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: parseInt(process.env.POSTGRES_PORT || '5432'),
    database: process.env.POSTGRES_DB || 'monize',
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
  })
  await client.connect()

  // 2. Look up user by email
  const email = process.env.MIGRATION_USER_EMAIL
  if (!email) throw new Error('MIGRATION_USER_EMAIL not set')
  const userResult = await client.query('SELECT id FROM users WHERE email = $1', [email])
  if (userResult.rows.length === 0) throw new Error(`User not found: ${email}`)
  const userId: string = userResult.rows[0].id
  console.log(`Importing for user: ${email} (${userId})\n`)

  // 3. Begin transaction
  await client.query('BEGIN')

  try {
    // 4. Delete existing data (FK-safe order)
    await deleteExistingData(client, userId)

    // 5. Ensure NZD currency exists
    await ensureCurrencies(client)

    // 6-12. Import each entity type (tasks 5-9)
    // ...

    // 13. Compute account balances
    await computeBalances(client, userId)

    await client.query('COMMIT')
    console.log('\nImport complete.')
  } catch (err) {
    await client.query('ROLLBACK')
    throw err
  } finally {
    await client.end()
  }
}
```

**deleteExistingData(client, userId)** — issues DELETE statements in FK-safe order. Each table with a `user_id` column gets `DELETE FROM <table> WHERE user_id = $1`. Tables without `user_id` that reference user-owned data (e.g. `transaction_splits` via `transactions`, `security_prices` via `securities`) use subqueries:

```sql
DELETE FROM transaction_splits WHERE transaction_id IN
  (SELECT id FROM transactions WHERE user_id = $1);
DELETE FROM security_prices WHERE security_id IN
  (SELECT id FROM securities WHERE user_id = $1);
```

Log the count of deleted rows for each table.

**ensureCurrencies(client)** — insert NZD if it doesn't exist:

```sql
INSERT INTO currencies (code, name, symbol, decimal_places)
VALUES ('NZD', 'New Zealand Dollar', 'NZ$', 2)
ON CONFLICT (code) DO NOTHING;
```

**Step 2: Commit**

```bash
git add migration/migrate.ts
git commit -m "feat: add migration script skeleton with cleanup and currency setup"
```

---

### Task 5: Import reference data — payees, categories, securities

**Files:**
- Modify: `migration/migrate.ts`

Add three functions and call them from `main()`. Each maintains an ID map (`Map<number, string>`) returned to the caller for FK resolution.

**migratePayees(client, userId, mdbFile)**

Read `PAY` table. For each row with valid `hpay` and `szFull`:
- Generate a UUID (use `gen_random_uuid()` via SQL or `crypto.randomUUID()` in Node)
- INSERT into `payees` with `(id, user_id, name)`
- Add to `payeeMap: Map<number, string>` (Money hpay -> UUID)

**migrateCategories(client, userId, mdbFile)**

Read `CAT` table. Sort by `nLevel` ascending (parents first). For each row:
- Generate UUID
- Look up `parentId` via `categoryMap` if `hcatParent` is set
- INSERT into `categories` with `(id, user_id, parent_id, name, is_income: false, is_system: false)`
- The `UNIQUE(user_id, name, parent_id)` constraint handles deduplication

**migrateSecurities(client, userId, mdbFile, currencyMap)**

Read `SEC` table. For each row:
- Generate UUID
- Map `hcrnc` to currency code via `currencyMap` (from CRNC table), default to `'NZD'`
- INSERT into `securities` with `(id, user_id, symbol, name, security_type, exchange, currency_code)`
- `security_type`: not directly available in Money data; default to `'STOCK'`
- `symbol`: from `szSymbol`, fallback to name-derived symbol if blank
- Add to `securityMap: Map<number, string>`

**Step 2: Commit**

```bash
git add migration/migrate.ts
git commit -m "feat: import payees, categories, and securities from Money file"
```

---

### Task 6: Import accounts

**Files:**
- Modify: `migration/migrate.ts`

**migrateAccounts(client, userId, mdbFile, currencyMap)**

Read `ACCT` table. Apply the same transformation logic from the reference migration:

1. Build `zClosedIds` set — accounts with "z " prefix and their `hacctRel` targets
2. For each row:
   - Generate UUID
   - Strip "z " from name
   - Determine `is_closed` from `fClosed === '1'` or membership in `zClosedIds`
   - Determine `is_favourite` from `fFavorite === '1'`
   - Map `at` to account_type via `parseAccountType()` (0 -> CHEQUING)
   - Map `hcrnc` to currency code via `currencyMap`
   - `opening_balance` from `amtOpen` (keep as decimal string)
   - INSERT into `accounts`

3. After all accounts inserted, process investment-cash links:
   - For `at=5` (INVESTMENT) rows with `hacctRel`:
     - UPDATE investment account: `account_sub_type = 'INVESTMENT_BROKERAGE'`, `linked_account_id` = cash account UUID
     - UPDATE cash account: `account_sub_type = 'INVESTMENT_CASH'`, `linked_account_id` = investment account UUID

Return `accountMap: Map<number, string>`

**Step 2: Commit**

```bash
git add migration/migrate.ts
git commit -m "feat: import accounts with investment-cash linking"
```

---

### Task 7: Import transactions, splits, and transfers

The largest and most complex step. Three sub-functions.

**Files:**
- Modify: `migration/migrate.ts`

**migrateTransactions(client, userId, mdbFile, accountMap, payeeMap, categoryMap)**

Read `TRN`, `TRN_SPLIT`, `BILL`, `TRN_XFER` tables. Build exclusion sets exactly as in the reference migration:

- `splitChildIds` — `TRN_SPLIT.htrn` values
- `billTemplateIds` — `BILL.lHtrn` values (excluding `-1`)
- `orphanedFromIds` — from `TRN_XFER` where the linked TRN has no account

For each non-excluded TRN row:
- Skip if `frq != -1` (and not empty), `grftt & 0x8000`, or `grftt & 0x80`
- Resolve `accountId` via `accountMap`, skip if missing
- Resolve `payeeId` via `payeeMap` (nullable)
- Resolve `categoryId` via `categoryMap` (nullable)
- Generate UUID
- Map `cs` field to status: `'0'` or empty -> `'UNRECONCILED'`, `'2'` -> `'RECONCILED'`
- `amount` stays as decimal string from `amt`
- `currency_code` from the account's currency (look up via account map, or store during account import)
- INSERT into `transactions`
- Add to `transactionMap: Map<number, string>`

Warn on sub-penny amounts (where `amt * 100` is not an integer).

**migrateSplits(client, mdbFile, transactionMap, categoryMap)**

Read `TRN_SPLIT` and `TRN` tables. For each split row:
- Look up parent transaction via `transactionMap[htrnParent]`, skip if not found
- Get the split child's TRN row for amount, category, memo
- Resolve `categoryId` via `categoryMap`
- INSERT into `transaction_splits`
- Also UPDATE the parent transaction: `is_split = true`

**migrateTransfers(client, mdbFile, transactionMap)**

Read `TRN_XFER`. For each row where both `htrnFrom` and `htrnLink` resolve in `transactionMap`:
- UPDATE the "from" transaction: `is_transfer = true`, `linked_transaction_id` = to-UUID
- UPDATE the "to" transaction: `is_transfer = true`, `linked_transaction_id` = from-UUID

**Step 2: Commit**

```bash
git add migration/migrate.ts
git commit -m "feat: import transactions, splits, and transfers"
```

---

### Task 8: Import investment transactions and security prices

**Files:**
- Modify: `migration/migrate.ts`

**migrateInvestmentTransactions(client, userId, mdbFile, accountMap, securityMap, transactionMap)**

Read `TRN_INV` and `TRN` tables. For each investment row:
- Look up TRN row for account, date, amount
- Resolve `accountId` via `accountMap`, `securityId` via `securityMap`
- If the TRN row wasn't imported as a transaction (excluded), create it now
- Determine `action` from quantity: positive=BUY, negative=SELL, zero quantity=DIVIDEND
- `total_amount` from the TRN `amt` field
- `price` from `dPrice`, `commission` from `amtCmn`, `quantity` from `qty`
- INSERT into `investment_transactions`

**migrateSecurityPrices(client, mdbFile, securityMap)**

Read `SP` table. Deduplicate by `(securityId, date)` in memory. Batch insert using multi-row INSERT (500 rows per statement for performance):

```sql
INSERT INTO security_prices (security_id, price_date, close_price)
VALUES ($1, $2, $3), ($4, $5, $6), ...
ON CONFLICT (security_id, price_date) DO NOTHING
```

**Step 2: Commit**

```bash
git add migration/migrate.ts
git commit -m "feat: import investment transactions and security prices"
```

---

### Task 9: Import exchange rates and scheduled transactions

**Files:**
- Modify: `migration/migrate.ts`

**migrateExchangeRates(client, mdbFile, currencyMap)**

Read `CRNC_EXCHG`. For each row:
- Resolve `hcrncFrom` and `hcrncTo` via `currencyMap`
- Parse date, validate rate > 0
- INSERT with `ON CONFLICT (from_currency, to_currency, rate_date) DO NOTHING`

**migrateScheduledTransactions(client, userId, mdbFile, accountMap, payeeMap, categoryMap)**

Read `BILL` and `TRN` tables. For each bill:
- Look up template TRN row via `lHtrn`
- Resolve account, payee, category from template
- Map frequency via `parseFrequency()`
- `next_due_date` and `start_date` from `dt`
- `is_active` from `st === '1'`
- `name` from payee name or memo (Money doesn't have a separate bill name — use payee name, falling back to "Scheduled payment")
- INSERT into `scheduled_transactions`

**Step 3: Commit**

```bash
git add migration/migrate.ts
git commit -m "feat: import exchange rates and scheduled transactions"
```

---

### Task 10: Compute account balances and final wiring

**Files:**
- Modify: `migration/migrate.ts`

**computeBalances(client, userId)**

Single UPDATE query:

```sql
UPDATE accounts SET current_balance = opening_balance + COALESCE(
  (SELECT SUM(amount) FROM transactions
   WHERE transactions.account_id = accounts.id
   AND transactions.parent_transaction_id IS NULL),
  0
)
WHERE user_id = $1
```

Note: exclude split children (those with `parent_transaction_id`) from the sum to avoid double-counting.

**Step 2: Wire everything together in `main()`**

Ensure `main()` calls all functions in the correct order, passing ID maps between them:

1. `deleteExistingData`
2. `ensureCurrencies`
3. Build `currencyMap` from CRNC table
4. `migratePayees` -> `payeeMap`
5. `migrateCategories` -> `categoryMap`
6. `migrateSecurities` -> `securityMap`
7. `migrateAccounts` -> `accountMap`
8. `migrateTransactions` -> `transactionMap`
9. `migrateSplits`
10. `migrateTransfers`
11. `migrateInvestmentTransactions`
12. `migrateSecurityPrices`
13. `migrateExchangeRates`
14. `migrateScheduledTransactions`
15. `computeBalances`

**Step 3: Commit**

```bash
git add migration/migrate.ts
git commit -m "feat: compute account balances and wire up complete pipeline"
```

---

### Task 11: Write the README

**Files:**
- Create: `migration/README.md`

Document:
- What the tool does
- Prerequisites (Java, mdbtools, Node, running Postgres with monize schema)
- Setup instructions (copy .mny file, create .env from .env.example, npm install)
- How to run (`./migrate.sh`)
- What gets imported (with entity list and expected counts)
- Known limitations (lots not imported, holdings not computed, `is_income` defaults to false)
- How idempotency works (deletes existing user data, safe to re-run)

**Step 2: Commit**

```bash
git add migration/README.md
git commit -m "docs: add migration README with setup and usage instructions"
```

---

### Task 12: End-to-end test

Run the full pipeline against the real `.mny` file and verify results.

**Step 1: Ensure database is up and user exists**

Check that the monize database is running and the migration user email exists.

**Step 2: Run the pipeline**

Run: `cd migration && ./migrate.sh`

**Step 3: Verify counts**

Connect to Postgres and check record counts match expected ranges from the reference migration:
- Payees: ~3,000
- Categories: ~200
- Securities: ~169
- Accounts: ~122
- Transactions: ~37,000+
- Transaction splits: ~4,000+
- Transfers (linked transactions): ~5,000+
- Investment transactions: ~1,400+
- Security prices: ~42,000+
- Exchange rates: ~200+
- Scheduled transactions: ~80+

**Step 4: Spot-check balances**

Query a few known accounts and verify `current_balance` looks reasonable (opening_balance + sum of transactions).

**Step 5: Verify the pipeline is idempotent**

Run `./migrate.sh` a second time. Verify counts are identical (not doubled).

**Step 6: Commit any final fixes**

```bash
git commit -m "fix: address issues found during end-to-end testing"
```
