# Microsoft Money Data Model

Reference for the .mny file format (Access/MDB internally). Derived from analysis of a real Money file, not official documentation.

## Date Format

All dates are `MM/DD/YY HH:MM:SS`. The null sentinel is day `00` (e.g. `01/00/00 00:00:00`). Year uses a 70-year pivot: `>=70` maps to 1900s, `<70` maps to 2000s.

## Key Tables

| Table | Purpose |
|-------|---------|
| `ACCT` | Accounts (bank, investment, pension, etc.) |
| `PAY` | Payees |
| `CAT` | Categories (hierarchical) |
| `CRNC` | Currencies |
| `SEC` | Securities (stocks, funds, currencies) |
| `TRN` | All transactions (cash and investment) |
| `TRN_INV` | Investment-specific transaction detail (quantity, price) |
| `TRN_SPLIT` | Split transaction children |
| `TRN_XFER` | Transfer pairs |
| `BILL` | Scheduled/recurring transactions |
| `LOT` | Tax lot tracking (buy/sell pairs) |
| `SP` | Security price history |
| `CRNC_EXCHG` | Exchange rate history |
| `PORT_REC` | Portfolio records (appears unused or minimal) |
| `POS_STMT` | Position statements (appears unused or minimal) |

## Table Relationships

```
TRN (htrn) ──1:0..1──> TRN_INV (htrn)
TRN (htrn) ──1:0..*──> TRN_SPLIT (htrn)        child TRN row
TRN (htrn) ──1:0..*──> TRN_XFER (htrnFrom)      from side
TRN (htrn) ──1:0..*──> TRN_XFER (htrnLink)      to side
TRN (hacct) ──────────> ACCT (hacct)
TRN (hsec)  ──────────> SEC (hsec)
TRN (lHpay) ──────────> PAY (hpay)
TRN (hcat)  ──────────> CAT (hcat)
LOT (htrnBuy)  ───────> TRN (htrn)
LOT (htrnSell) ───────> TRN (htrn)
LOT (hacct) ──────────> ACCT (hacct)
LOT (hsec)  ──────────> SEC (hsec)
CAT (hcatParent) ─────> CAT (hcat)              self-referencing
BILL (lHtrn) ─────────> TRN (htrn)              template transaction
SP (hsec)  ───────────> SEC (hsec)
CRNC_EXCHG (hcrncFrom) > CRNC (hcrnc)
CRNC_EXCHG (hcrncTo)  ─> CRNC (hcrnc)
ACCT (hacctRel) ──────> ACCT (hacct)             investment-cash pairs
```

Not every investment-related TRN row has a TRN_INV row. Notably, dividend payments (act=4) and some corporate actions (act=14) exist only in TRN, with no quantity/price detail in TRN_INV.

## PAY Table (Payees)

| Field | Type | Description |
|-------|------|-------------|
| `hpay` | int | Primary key |
| `szFull` | string | Payee name |

## CAT Table (Categories)

| Field | Type | Description |
|-------|------|-------------|
| `hcat` | int | Primary key |
| `szFull` | string | Category name |
| `hcatParent` | int | FK to parent category (empty for top-level) |
| `nLevel` | int | Depth in hierarchy (0 = top-level) |

Categories are hierarchical. When inserting, sort by `nLevel` ascending to ensure parents exist before children.

## CRNC Table (Currencies)

| Field | Type | Description |
|-------|------|-------------|
| `hcrnc` | int | Primary key (used as FK in ACCT, SEC, etc.) |
| `szIsoCode` | string | ISO 4217 currency code (e.g. GBP, NZD, USD) |
| `szName` | string | Currency name |

## TRN Table (All Transactions)

### Key Fields

| Field | Type | Description |
|-------|------|-------------|
| `htrn` | int | Primary key |
| `hacct` | int | Account FK |
| `hsec` | int | Security FK (0 or empty for non-investment rows) |
| `dt` | datetime | Transaction date |
| `amt` | decimal | Cash amount (negative = cash leaving the account) |
| `act` | int | Action type (see below) |
| `hacctLink` | int | Linked account (for transfers between accounts) |
| `hcat` | int | Category FK |
| `lHpay` | int | Payee FK (to PAY.hpay) |
| `mMemo` | string | Memo/description |
| `szId` | string | Reference number (cheque number, etc.) |
| `frq` | int | Frequency: `-1` for normal transactions. Any other value = recurring bill instance auto-entered by the scheduler (see phantom transactions below) |
| `grftt` | int | Bit flags (see below) |
| `cs` | int | Cleared status: `0` = uncleared, `2` = reconciled. The `dtCleared` field is always the null sentinel and should be ignored |

### The `act` Field

The `act` field on TRN is the single most important field for investment transaction classification. Its values are not documented and several are misleading.

**Values that appear on investment transactions (have TRN_INV rows):**

| act | Meaning | TRN_INV row? | Opens lots | Closes lots |
|-----|---------|:------------:|:----------:|:-----------:|
| 0 | Buy | Yes | Yes | - |
| 1 | Sell | Yes | - | Yes |
| 3 | Reinvest (dividend reinvestment) | Yes | Yes | - |
| 5 | Reinvest (variant) | Yes | Yes | - |
| 15 | Add shares / cost basis record | Yes | Yes | - |
| 16 | Transfer (closes lots) | Yes | - | Yes |

**Values that appear on investment-related TRN rows WITHOUT TRN_INV rows:**

| act | Meaning | TRN_INV row? | Notes |
|-----|---------|:------------:|-------|
| 4 | Dividend / income distribution | No | Cash payment from a security. `hsec` identifies the security, `amt` is the payment amount (negative = cash out of the investment). No quantity change. |
| 14 | Corporate action (cash) | No | Rare. Cash-only events like returns of capital. No quantity change. |

**General TRN `act` values (non-investment):**

| act | Meaning |
|-----|---------|
| -1 | Regular transaction (non-investment) |
| 0 | Regular transaction (also used for buys in investment context) |
| 12 | Unknown (rare) |
| 32 | Unknown (rare) |
| 64 | Unknown (rare) |

### Critical Gotcha: act=16

act=16 looks like "transfer in" (shares arriving) but the LOT table proves it **closes lots**. When Money transfers shares between accounts, it records:

1. act=16 on the source side -- closes the old lots (removes shares)
2. act=15 on the destination side -- opens new lots (adds shares with cost basis)

So act=16 is functionally a **sell/transfer-out**, not a transfer-in. If you classify act=16 as adding shares, every transfer will double-count.

### The `grftt` Bit Field

| Bit | Mask | Meaning |
|-----|------|---------|
| 7 | `0x80` | Voided transaction. The original amount stays in TRN but Money treats it as zero for balance purposes. |
| 15 | `0x8000` | Auto-entered transaction (e.g. imported from online banking). |

### Phantom Transactions

The TRN table contains several categories of non-real transactions that must be excluded from migration:

1. **Recurring bill instances** (`frq != -1`): Auto-entered by the scheduler. When the user deletes one and records the real payment separately, the phantom remains.
2. **Auto-entered transactions** (`grftt & 0x8000`): Similar to recurring instances but with `frq = -1`. Identified by the bit flag.
3. **Voided transactions** (`grftt & 0x80`): Money treats the amount as zero but doesn't delete the row.
4. **Bill template transactions**: Referenced by `BILL.lHtrn`. These are templates for recurring transactions, not real transactions.
5. **Orphaned transfer sides**: When one side of a transfer is deleted, the other remains in TRN with a `TRN_XFER` entry pointing to a counterpart with no account.
6. **Split children**: TRN rows referenced by `TRN_SPLIT.htrn`. Their amounts are part of the parent transaction; importing them separately would double-count.

### Critical Gotcha: Quantity is Always Positive

In TRN_INV, the `qty` field is always positive regardless of whether it's a buy or sell. The direction comes entirely from the `act` field in TRN. Do not infer buy/sell from the sign of `qty`.

The `amt` field in TRN is signed (negative for sells and dividends), but don't use it for action classification either -- dividend reinvestments (act=3, act=5) also have negative `amt` (cash leaving to buy shares) and would be misclassified as sells.

## TRN_INV Table (Investment Detail)

| Field | Type | Description |
|-------|------|-------------|
| `htrn` | int | FK to TRN -- also the primary key |
| `dPrice` | decimal | Price per unit |
| `qty` | decimal | Quantity (always positive) |
| `amtCmn` | decimal | Commission |
| `fFract` | int | Fractional share flag |
| `lott` | int | Lot type (-1 = default) |

Only ~1,400 of ~45,000 TRN rows have corresponding TRN_INV rows. The join is on `htrn`.

## LOT Table (Tax Lots)

The LOT table is Money's authoritative record of share ownership. It pairs buy transactions with sell transactions at the lot level.

| Field | Type | Description |
|-------|------|-------------|
| `hlot` | int | Primary key |
| `htrnBuy` | int | FK to TRN -- the transaction that opened this lot |
| `htrnSell` | int | FK to TRN -- the transaction that closed this lot (empty/0 if still open) |
| `qty` | decimal | Lot quantity (0 if fully closed, otherwise the remaining open quantity) |
| `hacct` | int | Account FK |
| `hsec` | int | Security FK |
| `dtBuy` | datetime | Buy date |
| `dtSell` | datetime | Sell date (if closed) |
| `htrnOpen` | int | FK to TRN -- the opening transaction (usually same as htrnBuy) |
| `htrnClose` | int | FK to TRN -- the closing transaction (usually same as htrnSell) |
| `hlotOpen` | int | Self-referencing FK for lot splits |
| `hlotLink` | int | Linked lot (for transfers between accounts) |

### Deriving Current Holdings from LOT

To get current holdings, sum `qty` for lots where `htrnSell` is empty/0:

```sql
SELECT hsec, hacct, SUM(qty) as quantity
FROM LOT
WHERE htrnSell IS NULL OR htrnSell = 0
GROUP BY hsec, hacct
HAVING SUM(qty) > 0
```

This is the most reliable way to determine what Money considers as "currently held". It avoids all the complexity of replaying transactions and correctly handles transfers, splits, and corporate actions.

### LOT `htrnBuy` act Distribution

Only four `act` values appear as lot openers:

| act | Lots opened |
|-----|-------------|
| 0 (Buy) | ~1,800 |
| 5 (Reinvest) | ~190 |
| 15 (Add shares) | ~160 |
| 3 (Reinvest) | ~50 |

### LOT `htrnSell` act Distribution

Only two `act` values appear as lot closers:

| act | Lots closed |
|-----|-------------|
| 1 (Sell) | ~840 |
| 16 (Transfer) | ~80 |

## SEC Table (Securities)

| Field | Type | Description |
|-------|------|-------------|
| `hsec` | int | Primary key |
| `szExchg` | string | Exchange code |
| `szFull` | string | Full name |
| `szSymbol` | string | Ticker symbol |
| `sct` | int | Security type (1=stock, 2=bond, 3=mutual fund, 4=currency, etc.) |
| `hcrnc` | int | Currency FK |
| `hcntry` | int | Country FK |
| `fHidden` | int | Hidden flag |
| `dtLastHistQuote` | datetime | Last historical quote date |

### Symbol Conventions

- Domestic equities: plain symbol (e.g. `AUS`, `NZG`)
- Foreign equities: prefixed with exchange (e.g. `GB:VOD`, `US:VT`)
- Mutual funds with no symbol: `szSymbol` is empty, use `szFull` (often prefixed with `~`)
- Currencies: stored as securities with `sct=4`

## ACCT Table (Accounts)

| Field | Type | Description |
|-------|------|-------------|
| `hacct` | int | Primary key |
| `szFull` | string | Account name |
| `at` | int | Account type (see below) |
| `hcrnc` | int | Currency FK (to CRNC.hcrnc) |
| `amtOpen` | decimal | Opening balance |
| `fClosed` | int | Closed flag (1 = closed) |
| `fFavorite` | int | Favourite flag |
| `hacctRel` | int | Linked account FK (investment-cash pairs, only meaningful for `at=5`) |

### Account Types (`at` field)

| at | Meaning |
|----|---------|
| 0 | Bank (chequing/savings) |
| 1 | Credit card |
| 2 | Cash |
| 3 | Asset |
| 4 | Loan |
| 5 | Investment |
| 6 | Mortgage |

### Investment Account Pairs

Investment accounts in Money typically come in pairs:

1. **Investment account** (`at=5`) -- holds securities, linked to TRN_INV transactions
2. **Cash account** (`at=0`) -- holds the cash balance within the investment account

The `hacctRel` field on an investment account points to its associated cash account. Not all investment accounts have a linked cash account.

## TRN_SPLIT Table (Split Transaction Children)

| Field | Type | Description |
|-------|------|-------------|
| `htrn` | int | FK to TRN -- the child transaction row |
| `htrnParent` | int | FK to TRN -- the parent transaction |

The child's amount, category, and memo live on its TRN row (looked up via `htrn`), not in TRN_SPLIT itself. The child TRN rows should not be imported as standalone transactions.

## TRN_XFER Table (Transfer Pairs)

| Field | Type | Description |
|-------|------|-------------|
| `htrnFrom` | int | FK to TRN -- the "from" side of the transfer |
| `htrnLink` | int | FK to TRN -- the "to" side of the transfer |

Both sides of the transfer exist as separate TRN rows with their own amounts (one negative, one positive).

## BILL Table (Scheduled/Recurring Transactions)

| Field | Type | Description |
|-------|------|-------------|
| `hbill` | int | Primary key |
| `lHtrn` | int | FK to TRN -- the template transaction (not a real transaction) |
| `frq` | int | Frequency: 0=once, 1=daily, 2=weekly, 3=monthly, 4=yearly, 5=bimonthly, 6=quarterly, 7=semiannually |
| `cFrqInst` | int | Interval (e.g. every 2 months) |
| `dt` | datetime | Next due date |
| `st` | int | Status: 1 = active |

The template TRN row (referenced by `lHtrn`) provides the amount, payee, category, and memo for the scheduled transaction.

## SP Table (Security Prices)

| Field | Type | Description |
|-------|------|-------------|
| `hsec` | int | FK to SEC |
| `dt` | datetime | Price date |
| `dPrice` | decimal | Price per unit |

The source data may contain duplicate `(hsec, dt)` pairs. Deduplicate before inserting.

## CRNC_EXCHG Table (Exchange Rates)

| Field | Type | Description |
|-------|------|-------------|
| `hcrncFrom` | int | FK to CRNC -- source currency |
| `hcrncTo` | int | FK to CRNC -- target currency |
| `dt` | datetime | Rate date |
| `rate` | decimal | Exchange rate |

## Mapping to Portfolio Concepts

### Transaction Types

| Money act | Portfolio concept |
|-----------|-------------------|
| 0 | Buy -- acquire shares for cash |
| 1 | Sell -- dispose of shares for cash |
| 3, 5 | Reinvest -- dividend converted to shares (both cash outflow and share inflow) |
| 4 | Dividend -- cash distribution, no share movement |
| 15 | Share adjustment -- new lot with cost basis (transfers, splits, corporate actions) |
| 16 | Lot closure -- shares leaving via transfer (paired with act=15 at destination) |
| 14 | Cash corporate action -- return of capital or similar |

### Transfer Between Accounts

When shares move between accounts, Money records:

1. **Source account**: act=16 transaction closes the existing lots
2. **Destination account**: act=15 transaction opens new lots with cost basis

These two transactions share the same date and quantity. The act=15 transaction's `amt` field in TRN carries the cost basis for the new lots.

There is no `hacctLink` on either side -- the pairing is implicit (same date, same security, same quantity).

### Stock Splits

act=15 with `amt=0` and small fractional quantities typically represents dividend reinvestment adjustments or rounding corrections in pension/managed fund accounts.

act=15 with a larger quantity and matching `amt` represents a corporate action like a demerger (e.g. BHP spinning off South32 as `GB:S32` with act=15, qty=151).

### Dividend Reinvestment

Two variants exist:
- act=3: Standard reinvestment
- act=5: Alternate reinvestment (possibly automatic vs manual)

Both have TRN_INV rows with quantity and price. The TRN `amt` is negative (cash outflow to buy shares). Do not confuse the negative `amt` with a sell.
