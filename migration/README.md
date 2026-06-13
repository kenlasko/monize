# Microsoft Money Import

Import data from a Microsoft Money `.mny` file into the monize PostgreSQL database.

## Prerequisites

- **Java** runtime (for the sunriise decryption tool)
- **mdbtools** — `brew install mdbtools`
- **Node.js** (18+) and npm
- A running monize instance with the database schema applied
- A registered user account in monize (the import targets a specific user)

## Setup

1. Copy your `.mny` file into this directory as `source.mny`

2. Create a `.env` file from the example:

   ```bash
   cp .env.example .env
   ```

3. Edit `.env` with your values:
   - `MONEY_FILE_PASSWORD` — the password you set in Microsoft Money
   - `MIGRATION_USER_EMAIL` — the email of the monize user to import into
   - `POSTGRES_*` — database connection matching your monize instance

4. Install dependencies:

   ```bash
   npm install
   ```

## Usage

```bash
./migrate.sh
```

The script will:

1. Download the [sunriise](https://github.com/hung-le/sunriise2-misc) JAR if not already present
2. Decrypt `source.mny` to `source.mdb`
3. Extract all tables via `mdb-export` and import into PostgreSQL

The entire import runs inside a single database transaction. If anything fails, all changes are rolled back.

## What gets imported

| Source table | Target table | Notes |
|---|---|---|
| `CRNC` | `currencies` | Ensures all referenced currencies exist |
| `PAY` | `payees` | |
| `CAT` | `categories` | Hierarchical (parents first) |
| `SEC` | `securities` | |
| `ACCT` | `accounts` | Includes investment-cash account linking |
| `TRN` | `transactions` | With phantom/void/auto-entered exclusions |
| `TRN_SPLIT` | `transaction_splits` | Sets `is_split` on parent transactions |
| `TRN_XFER` | (updates transactions) | Sets `is_transfer` and `linked_transaction_id` |
| `TRN_INV` | `investment_transactions` | BUY/SELL/DIVIDEND from quantity sign |
| `SP` | `security_prices` | Deduplicated, batch inserted |
| `CRNC_EXCHG` | `exchange_rates` | Additive (ON CONFLICT DO NOTHING) |
| `BILL` | `scheduled_transactions` | Frequency mapped to nearest equivalent |

Account balances are computed after all transactions are imported.

## Idempotency

The script deletes all existing data for the target user before importing. It's safe to run repeatedly — each run produces a clean import.

Exchange rates are the exception: they have no user ownership and are inserted additively (existing rates are preserved).

## Known limitations

- **Lots** (cost basis tracking) are not imported — monize has no equivalent table
- **Holdings** are not computed — the application's holdings rebuild handles this
- **Category `is_income`** defaults to `false` for all imported categories
- **Frequency mapping**: Microsoft Money's BIMONTHLY maps to BIWEEKLY, and SEMIANNUALLY maps to YEARLY (the closest available values in monize)
- **Account types**: all Money "BANK" accounts import as CHEQUING

## Transaction exclusion rules

The following Money transactions are excluded (matching the reference migration):

- Recurring bill instances (`frq != -1`)
- Auto-entered transactions (`grftt` bit 15)
- Voided transactions (`grftt` bit 7)
- Bill template transactions (referenced by `BILL.lHtrn`)
- Orphaned transfer sides (counterpart account deleted)
- Split child transactions (represented via `transaction_splits` instead)
