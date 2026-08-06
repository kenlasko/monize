# Financial Semantics

What the numbers mean: signs, legs, rate direction, precision, and the exact
arithmetic each derived figure is defined by. This is the narrow reference that
`docs/financial-calculation-contract.md` and `docs/time-series-contract.md`
assume. Those two own missing-data propagation, the cost-basis/tax truth table,
materialized-result versioning, adjusted-versus-raw prices and period
boundaries; none of that is repeated here. Root `CLAUDE.md` states the
`decimal(20,4)` and `roundFxRate` rules at a glance -- this document gives the
full field table and the call sites.

It exists because a semantic that lives in three places drifts in two of them.
Every gap in section 9 is a place where two code paths currently answer the same
question differently, and each was found by reading the paths side by side
rather than by either one failing a test.

## 1. Signs

`transactions.amount` is a single signed `decimal(20,4)`. There is no debit/credit
column and no type flag:

```text
positive  = money entering the account (income)
negative  = money leaving the account (expense)
```

The sign is supplied by the caller and validated only for range and precision.
No server rule requires an income category to carry a positive amount, so the
category and the sign can disagree; code that needs to know direction must read
the sign, not the category.

For transfers the sign is structural rather than caller-supplied. The DTO's
`amount` must be non-negative, and `createTransfer` writes the source leg as
`-amount` and the destination leg as `+toAmount`. Consequently **the sign is
what identifies a leg**, and the transfer service re-derives it repeatedly:

```typescript
const isFromTransaction = Number(transaction.amount) < 0;
```

There is no stored "this is the source leg" flag. A change that could make a
source leg non-negative breaks leg identification everywhere at once.

For a foreign-currency entry, `normalizeFxEntry` requires `originalAmount` and
`amount` to share a sign (either may be exactly zero).

## 2. Transfers

A transfer is **two linked `transactions` rows**, each pointing at the other via
`linkedTransactionId` -- not one row with two accounts. A transfer that is one
leg of a split is different again: it links through
`transaction_splits.linkedTransactionId`, and the counterpart's
`linkedTransactionId` points at the split *parent*, not at a mirror leg. That is
why the split-transfer paths are separate code from the plain pair throughout
`transaction-transfer.service.ts`, and why a fix to one has repeatedly missed
the other.

`toAmount` is:

```text
toAmount = explicit toAmount, if supplied
         = roundMoney(amount * exchangeRate), otherwise
```

An explicitly supplied `toAmount` wins outright. **Nothing cross-checks it
against `amount * exchangeRate`**, at any tolerance -- a client may state a
destination amount arbitrarily far from the rate-implied one and it is stored as
given. If a tolerance is wanted, it does not exist yet; do not write code that
assumes one.

### Status must move on both legs or neither

A transfer's two legs are one economic fact. Setting one leg to `VOID` while the
other stays active makes money exist in one account and not the other: a 100.00
transfer whose source leg alone is voided restores the source balance and leaves
the destination credited, so 1,000.00 held across two accounts reads as 1,100.00.

```text
FIN-001
Any write that changes a transfer leg's `status`, or that moves a balance on the
strength of a status, must apply to both legs in the same transaction, or to
neither.
```

## 3. Exchange rates

**Direction.** `exchangeRate` is *account-currency units per one unit of
`originalCurrencyCode`* -- the account currency is the quote, the foreign
currency is the base:

```text
amount ~= roundMoney(originalAmount * exchangeRate)

Source: 100.00 USD in a CAD account
Rate:   1.3500 CAD per USD
Stored: originalAmount 100.00, originalCurrencyCode USD, exchangeRate 1.3500,
        amount 135.00
```

**Precision.** A rate is not money. `roundFxRate` rounds to
`FX_RATE_DECIMALS = 10`, matching the `NUMERIC(20,10)` columns; display uses
`FX_RATE_DISPLAY_DECIMALS = 6`. `roundMoney(1 / 1.3652)` gives `0.7325`, which
inverts back to `1.3661` -- four decimal places on a rate is a reconciliation
error, not a rounding preference.

**Conversion.** `applyFxConversion` folds the account's `fxFeePercent` in as a
cost, always reducing the magnitude:

```typescript
const base = roundMoney(originalAmount * rate);
const fee = fxFeePercent && fxFeePercent > 0
  ? -roundMoney((Math.abs(base) * fxFeePercent) / 100)
  : 0;
return { base, fee, amount: roundMoney(base + fee) };
```

No separate fee row is written; the Foreign Currency Fees report derives the fee
back out of `(originalAmount, exchangeRate, amount)`. That derivation is the
reason all three must stay mutually consistent on every write.

**Validation.** `normalizeFxEntry(input, accountCurrencyCode)` is shared by
transactions and scheduled transactions so both accept and reject exactly the
same shapes:

| Input | Result |
| --- | --- |
| Neither `originalAmount` nor `originalCurrencyCode` | Both `null` -- an ordinary entry |
| Exactly one of the pair | Rejected, `fxFieldsIncomplete` |
| `originalCurrencyCode` equals the account currency | Stripped to both `null`, tolerated |
| A foreign pair with no `exchangeRate`, or one `<= 0` | Rejected, `fxRateRequired` |
| `originalAmount` and `amount` with opposite signs | Rejected, `fxSignMismatch` |

### A missing rate is not a rate of 1

```text
FIN-002
An unavailable exchange rate makes the converted value unknown. It must
propagate as unknown. It may never be replaced by 1, and an unconvertible amount
may never be returned under the target currency's label.
```

The two forms this violation takes, both present today, are worth naming
because neither looks wrong locally:

```typescript
rate = reverseRate !== null ? 1 / reverseRate : 1;   // an else-branch of 1
return result ?? amount;                             // the unconverted amount, relabelled
```

The first reports a USD position in CAD at par. The second returns the USD
figure under a CAD heading, which is worse than an error because it is
plausible. `docs/financial-calculation-contract.md` section 1 governs what to
return instead.

## 4. Precision by field

Money is `decimal(20,4)`. Everything below is a deliberate exception; a value
whose column is wider must not be rounded to money precision on the way in.

| Field | Precision | Note |
| --- | --- | --- |
| `transactions.amount`, `transaction_splits.amount`, `accounts.opening_balance`, `accounts.current_balance`, budget amounts, `investment_transactions.total_amount`, `investment_transactions.commission` | `NUMERIC(20,4)` | money |
| `exchange_rates.rate` and every `exchange_rate` column that mirrors it | `NUMERIC(20,10)` | round with `roundFxRate`, display at 6dp |
| `investment_transactions.quantity`, `holdings.quantity`, `scheduled_transactions.investment_quantity` | `NUMERIC(20,8)` | share counts -- and the SPLIT ratio, see section 6 |
| `investment_transactions.price`, `holdings.average_cost`, `security_prices.{open,high,low,close,adjusted_close}_price`, `scheduled_transactions.investment_price` | `NUMERIC(24,10)` | per-share prices are wider than money |
| `accounts.interest_rate`, `accounts.fx_fee_percent` | `NUMERIC(8,4)` | percentages |
| Monte Carlo rate inputs | `NUMERIC(8,6)` | |

The MS Money importer narrows investment values to 6dp price / 8dp quantity
before writing. That is an importer choice about source fidelity, not the
storage precision, and it is the one place the two legitimately differ.

## 5. Splits

`validateSplitAmountSum` requires at least two splits (unless a single
transfer/investment pass-through) and that the children sum exactly to the
parent at full money precision:

```typescript
const roundedSum = sumMoney(splits.map((s) => Number(s.amount)));
const roundedAmount = roundMoney(Number(transactionAmount));
if (roundedSum !== roundedAmount) throw new BadRequestException(...);
```

`sumMoney` accumulates in integer ten-thousandths rather than adding floats, so
the canonical case sums exactly:

```text
-3.3333 - 3.3333 - 3.3334 = -10.0000
```

Note what makes this work: the comparison happens at 4dp, the storage
precision. Rounding to cents before comparing -- which a currency input is
tempted to do -- makes three amounts that do not sum appear to.

## 6. Investments

### Cost basis includes acquisition commission

```text
Buy: 10 shares at 20.00, commission 5.00
Total basis:     205.00
Basis per share:  20.50
```

`total_amount` is `quantity * price + commission` for a BUY and
`quantity * price - commission` for a SELL, so a sell's commission reduces
proceeds. Cash impact mirrors this exactly: `-(qp + c)` on a buy, `qp - c` on a
sell.

A zero or absent price must not be treated as a free acquisition;
`portfolio-calculation.service.ts` guards this explicitly, and
`docs/financial-calculation-contract.md` section 2 has the truth table.

### Average cost, not FIFO

A SELL draws basis down proportionally at the running average cost per share:

```typescript
const sellQty = Math.min(quantity, entry.quantity);
const avgCostPerShare = entry.quantity > 0 ? entry.costBasis / entry.quantity : 0;
const costBasisSold = sellQty * avgCostPerShare;
const realizedGain = proceeds - costBasisSold;
```

### A SPLIT multiplies

```text
FIN-003
A SPLIT scales the running share count by its ratio and scales per-share cost by
its reciprocal, preserving total basis. It never adds the ratio to the share
count, and it is never grouped with BUY, REINVEST or TRANSFER_IN.

Starting quantity: 90 shares
Split ratio:       2.0
Correct result:    180 shares
Additive result:    92 shares   (a difference of -88 shares)
```

The ratio is stored in the `quantity` column of the `SPLIT` investment
transaction, validated only as `> 0`. A reverse split is the same operation with
a ratio below one -- `reverseSplit(ratio)` is literally
`applySplit(1 / ratio)`, and a 1-for-2 reverse split is `ratio = 0.5`, halving
shares and doubling per-share cost. There is no separate reverse-split action,
so any code that special-cases "ratio greater than one" is wrong for half the
inputs.

`holdings.service.ts` implements this correctly (`qty *= txQty`). Section 9
records where it is implemented additively instead.

## 7. Scheduled occurrences

An occurrence may carry an override. `scheduled_transaction_overrides` is unique
on `(scheduled_transaction_id, override_date)`, so one occurrence has at most one
override.

```text
FIN-004
A stored override price is a decision the user made about that occurrence.
Reopening the editor must not replace it with the current market price. Applying
a fresh quote is an explicit action, never a side effect of opening a dialog.
```

Ten shares stored at 100.00 that come back as ten at 120.00 -- with the total
silently recomputed -- is a money field changed by nobody, and the user has no
way to tell it happened.

## 8. Import and restore: zero, null, absent

The MS Money importer is deliberately not uniform, and the distinction is worth
preserving rather than tidying:

- **Investment `price` and `quantity` propagate `null`.** `positiveOrNull`
  returns `null` for an absent or non-positive value, and the writer stores it
  as `null`. This is what keeps the zero-price-acquisition guard able to see
  "unknown" rather than "free".
- **Cash amounts default to `0`.** `toAmount` returns `0` for a missing or
  non-finite value, and `total_amount` is `NOT NULL` with no null path. This is
  defensible because Money's own missing-column semantics already collapse to
  zero for a cash figure -- an absent `amt` genuinely means zero, not unknown.

The rule that follows is about which of the two a new field is:
`docs/financial-calculation-contract.md`'s note that `null` means "not known"
and a settled zero must not be reported as unknown applies in both directions
here. Decide which the source column actually means before choosing a default.

## 9. Gap register

Places where two paths currently answer the same question differently. Each was
confirmed by reading `main`; each is a divergence, not a style difference.

| Question | Divergence |
| --- | --- |
| What does a SPLIT do to a share count? | `holdings.service.ts` multiplies (`qty *= txQty`, and `next = current * quantity`). `net-worth.service.ts` **adds**, at all three of its reducers -- and at one of them SPLIT is grouped with `BUY`/`REINVEST`/`TRANSFER_IN`. The holdings page and every historical net-worth chart therefore disagree about the same position after any split. `net-worth.service.ts` also handles no `ADD_SHARES`/`REMOVE_SHARES` at all, so those move the share count in one view and not the other. Breaches FIN-003. |
| What is an unavailable rate worth? | `portfolio-calculation.service.ts` falls back to `rate = 1`; `net-worth.service.ts` returns `result ?? amount`, relabelling an unconverted amount as the target currency. Breaches FIN-002. |
| Is acquisition commission in the cost basis? | `calculateCostBasisLotsInAccountCurrency` includes it (`quantity * price + commission`); `calculateRealizedGains` does not (`quantity * price`), while still taking proceeds net of the sell commission -- so realized gain is overstated by the buy-side commission relative to every other basis figure in the app. The code comments this discrepancy itself and declines to resolve it, correctly noting that reconciling the two changes every realized-gain figure in the application and so is its own change. Recorded here so the two are not mistaken for one rule. |
| Does a status change reach both transfer legs? | `PATCH /:id/transfer` mirrors `status` to both legs. `PATCH /transactions/:id/status` (and `markCleared`/`reconcile`/`unreconcile`) touch only the row given -- the reconciliation service references neither `isTransfer` nor `linkedTransactionId`. Bulk update mirrors `payeeId`/`payeeName`/`description` to the linked leg but not `status`. Breaches FIN-001. |
| Does a cross-currency transfer need a real rate? | `exchangeRate` defaults to `1` with no server-side resolution or rejection, and balances are updated regardless of `status`, so a transfer created as `VOID` still moves both balances. Breaches FIN-001 and FIN-002. |
| Is a stored override price safe? | `OverrideEditorDialog` seeds from the stored value correctly, then an unconditional effect overwrites `investmentPrice` whenever the fetched market price differs from the last seen one, recomputing the total from it. Breaches FIN-004. |

A note on how these are meant to be closed. FIN-002 and FIN-003 are each
scattered across several call sites, and every previous attempt fixed one site
and left the others live. The durable form of these two rules is a scanning
test, per root `CLAUDE.md`: one that fails on any `: 1` else-branch beside a rate
lookup, any `?? amount` beside a conversion, and any `SPLIT` case outside the
single shared reducer. Prose has already been insufficient here more than once.
