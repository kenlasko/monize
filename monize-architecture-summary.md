# Monize Architecture & Financial Features Summary

---

## Database Schema

### Core Tables

**`accounts`**
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `user_id` | UUID | FK to users |
| `account_type` | ENUM | See account types below |
| `account_sub_type` | ENUM | `INVESTMENT_CASH`, `INVESTMENT_BROKERAGE` |
| `linked_account_id` | UUID | For investment pairs |
| `name` | varchar | |
| `description` | varchar | |
| `currency_code` | char(3) | ISO 4217 |
| `account_number` | varchar | Masked |
| `institution` | varchar | |
| `opening_balance` | decimal(20,4) | |
| `current_balance` | decimal(20,4) | |
| `credit_limit` | decimal(20,4) | Credit card |
| `interest_rate` | decimal(10,4) | |
| `statement_due_day` | int | Credit card |
| `statement_settlement_day` | int | Credit card |
| `is_closed` | bool | |
| `closed_date` | date | |
| `is_favourite` | bool | |
| `payment_amount` | decimal | Loan/mortgage |
| `payment_frequency` | ENUM | Loan/mortgage |
| `payment_start_date` | date | |
| `source_account_id` | UUID | Where loan payments come from |
| `principal_category_id` | UUID | Loan principal category |
| `interest_category_id` | UUID | Loan interest category |
| `asset_category_id` | UUID | For ASSET accounts |
| `date_acquired` | date | ASSET accounts |
| `is_canadian_mortgage` | bool | Semi-annual compounding |
| `is_variable_rate` | bool | Mortgage |
| `term_months` | int | Mortgage term |
| `term_end_date` | date | |
| `amortization_months` | int | Mortgage amortization |
| `original_principal` | decimal | |

**`transactions`**
| Column | Type | Notes |
|--------|------|-------|
| `id` | UUID | PK |
| `user_id` | UUID | |
| `account_id` | UUID | |
| `transaction_date` | date | |
| `payee_id` | UUID | |
| `payee_name` | varchar | |
| `category_id` | UUID | |
| `amount` | decimal(20,4) | Negative = debit |
| `currency_code` | char(3) | |
| `exchange_rate` | decimal(20,10) | |
| `description` | varchar | |
| `reference_number` | varchar | |
| `status` | ENUM | `UNRECONCILED`, `CLEARED`, `RECONCILED`, `VOID` |
| `is_split` | bool | |
| `parent_transaction_id` | UUID | For splits |
| `is_transfer` | bool | |
| `linked_transaction_id` | UUID | The other side of a transfer |

**`transaction_splits`**
| Column | Type |
|--------|------|
| `transaction_id` | UUID |
| `category_id` | UUID |
| `transfer_account_id` | UUID |
| `linked_transaction_id` | UUID |
| `amount` | decimal(20,4) |
| `memo` | varchar |

**`categories`**
| Column | Type | Notes |
|--------|------|-------|
| `parent_id` | UUID | Self-referencing, for hierarchy |
| `name` | varchar | |
| `is_income` | bool | Expense vs income |
| `is_system` | bool | Cannot be deleted |
| `icon`, `color` | varchar | |

**`securities`**
| Column | Type | Notes |
|--------|------|-------|
| `symbol` | varchar | Ticker |
| `name` | varchar | |
| `security_type` | ENUM | `STOCK`, `ETF`, `MUTUAL_FUND`, `BOND` |
| `exchange` | varchar | |
| `currency_code` | char(3) | |
| `skip_price_updates` | bool | |
| `sector`, `industry` | varchar | |
| `sector_weightings` | JSONB | |

**`holdings`**
| Column | Type | Notes |
|--------|------|-------|
| `account_id` | UUID | FK to brokerage account |
| `security_id` | UUID | |
| `quantity` | decimal(20,8) | |
| `average_cost` | decimal(20,6) | Cost basis |

**`investment_transactions`**
| Column | Type | Notes |
|--------|------|-------|
| `transaction_id` | UUID | Linked cash transaction |
| `funding_account_id` | UUID | Source of funds for buy/sell |
| `action` | ENUM | See actions below |
| `quantity` | decimal | |
| `price` | decimal | |
| `commission` | decimal | |
| `total_amount` | decimal | |

**`scheduled_transactions`** — recurring transactions with frequency, auto-post, and reminder support.

---

## Account Types

There are 10 account types:

| Type | Class | Notes |
|------|-------|-------|
| `CHEQUING` | Asset | Standard checking account |
| `SAVINGS` | Asset | |
| `CASH` | Asset | Physical cash |
| `INVESTMENT` | Asset | Brokerage/portfolio |
| `ASSET` | Asset | Fixed assets (real estate, vehicles) |
| `CREDIT_CARD` | Liability | `credit_limit`, statement cycle fields |
| `LOAN` | Liability | Payment schedule, interest/principal split |
| `MORTGAGE` | Liability | Canadian mortgage support, amortization, term |
| `LINE_OF_CREDIT` | Liability | |
| `OTHER` | Asset | Miscellaneous |

Classification (asset vs liability) is determined by the account type — there is no separate field. Assets carry a positive balance as wealth; liabilities carry a negative balance as debt owed.

**Income/Expense** is a category-level concept (`is_income` flag on categories), not an account type. There are no dedicated Income or Expense account types — these are tracked through transaction categories.

---

## Account Creation Modals

### Fields for All Accounts
- Account type (required)
- Name (required)
- Currency (required)
- Opening balance
- Description, account number, institution (optional)
- Is favourite

### Credit Card — Additional Fields
- Credit limit
- Statement due day (1–31)
- Statement settlement day (last day of billing cycle)

### Loan — Additional Fields
- Payment amount and frequency (WEEKLY, BIWEEKLY, MONTHLY, QUARTERLY, YEARLY)
- Payment start date
- Source account (where payments are drawn from)
- Interest category (defaults to "Loan Interest" system category)

### Mortgage — Additional Fields
- Payment frequency (MONTHLY, SEMI_MONTHLY, BIWEEKLY, ACCELERATED_BIWEEKLY, WEEKLY, ACCELERATED_WEEKLY)
- Is Canadian mortgage (semi-annual compounding)
- Is variable rate
- Term months (e.g., 60 for 5-year term)
- Amortization months (e.g., 300 for 25 years)
- Source account

### Asset — Additional Fields
- Date acquired (excludes from net worth before this date)
- Asset category (for tracking value changes)

### Investment — Additional Field
- **Create investment pair** (bool): auto-creates two linked accounts — a cash account and a brokerage account (see below)

---

## Investment Account Pairs (Account Linking)

When `createInvestmentPair=true`, two accounts are created atomically:

| Account | Sub-type | Purpose |
|---------|----------|---------|
| `{name} - Cash` | `INVESTMENT_CASH` | Holds currency balance |
| `{name} - Brokerage` | `INVESTMENT_BROKERAGE` | Holds securities/holdings |

- Both accounts reference each other via `linked_account_id`
- Opening balance goes to the cash account; brokerage starts at 0
- They must be closed together; closure requires zero cash balance
- The endpoint `GET /accounts/:id/investment-pair` returns both linked accounts
- Portfolio-level calculations aggregate both sides

You can also create a standalone `INVESTMENT` account without a pair (e.g., for a self-directed account where cash is not tracked separately).

---

## Transfers

Transfers are implemented as **two linked transactions** — one debit in the source account, one credit in the destination — created atomically via a database transaction (QueryRunner).

Both transactions have:
- `is_transfer = true`
- `linked_transaction_id` pointing to each other

### Transfer Creation Fields
| Field | Notes |
|-------|-------|
| `fromAccountId`, `toAccountId` | Required |
| `transactionDate` | Required |
| `amount` | Positive, from-account currency |
| `fromCurrencyCode`, `toCurrencyCode` | Defaults to account currencies |
| `exchangeRate` | Optional, default 1.0 |
| `toAmount` | Optional override (for precise cross-currency control) |
| `payeeId`, `payeeName` | Auto-named "Transfer to/from {account name}" |
| `description`, `referenceNumber` | Optional |
| `status` | Default UNRECONCILED |

### Cross-Currency Transfers
Either provide `toAmount` directly, or provide `exchangeRate` and `toAmount` is calculated as `amount × exchangeRate` (rounded to 4 decimal places).

### Balance Updates
- **Past/present dated**: atomic SQL increment (`current_balance = current_balance + delta`)
- **Future dated**: balance recalculated from all transactions up to today

Deleting a transfer removes both linked transactions atomically. Updating can change accounts, amounts, currencies, and dates.

---

## Reconciliation

Reconciliation follows a bank-statement workflow with a 4-state status on each transaction:

| Status | Meaning |
|--------|---------|
| `UNRECONCILED` | Default, not yet reviewed |
| `CLEARED` | Visible in bank feed, not yet formally reconciled |
| `RECONCILED` | Confirmed against a statement, `reconciled_date` set |
| `VOID` | Transaction reversed/cancelled |

### Workflow
1. **Mark Cleared** — toggles UNRECONCILED ↔ CLEARED (cannot change RECONCILED or VOID)
2. **Reconcile session** — call `getReconciliationData(accountId, statementDate, statementBalance)`, which returns:
   - All unreconciled + cleared transactions up to statement date
   - `reconciledBalance` = opening balance + sum of all RECONCILED transactions
   - `clearedBalance` = reconciledBalance + sum of CLEARED transactions
   - `difference` = statementBalance − clearedBalance (target: 0)
3. **Bulk reconcile** — pass a list of transaction IDs; all are moved to RECONCILED with a `reconciled_date`
4. **Unreconcile** — reverts RECONCILED → CLEARED (clears `reconciled_date`)

VOID transitions on past-dated transactions update the account balance atomically.

---

## Dividends

Dividends are recorded as investment transactions with `action = DIVIDEND`.

### Dividend Flow
```
DIVIDEND investment_transaction (security, amount)
    -> creates linked cash transaction in the CASH sub-account
    -> payee: "Dividend: SYMBOL $amount"
    -> status: CLEARED
    -> updates cash account balance
```

### Destination Options

| Scenario | Where dividend lands |
|----------|---------------------|
| Investment pair exists | Automatically credited to the linked `INVESTMENT_CASH` account |
| Standalone investment account | Amount added directly to that account |
| Reinvestment | Use `REINVEST` action type — purchases additional shares with the proceeds (combines dividend + buy in one action) |

There is no mechanism to route a dividend to a completely separate, unlinked cash account — the dividend destination is always the linked cash account of the pair, or the account itself if unpaired.

### All Investment Action Types
`BUY`, `SELL`, `DIVIDEND`, `INTEREST`, `CAPITAL_GAIN`, `SPLIT`, `TRANSFER_IN`, `TRANSFER_OUT`, `REINVEST`, `ADD_SHARES`, `REMOVE_SHARES`

---

## Key Design Decisions

1. **No dedicated Income/Expense account types** — income and expenses are tracked as transaction categories with an `is_income` flag. Net worth is entirely account-balance driven.
2. **Investment pairs are optional** — you can track a brokerage account with or without a paired cash account.
3. **Transfers are symmetric** — always two real transactions linked together, never a single "transfer" record. This means each side shows up in its account's ledger.
4. **Reconciliation is statement-based** — built around the flow of: cleared → reconcile session with target balance → bulk confirm.
5. **Dividends always flow through the linked cash account** — there is no "dividend reinvestment plan" that bypasses the cash account; REINVEST is a separate explicit action.
6. **Loan/mortgage payments are decomposed** — the `interest_category_id` and `principal_category_id` allow split transactions to correctly categorize interest vs. principal portions.
