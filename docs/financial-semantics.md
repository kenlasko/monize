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
Every gap in section 10 is a place where two code paths currently answer the same
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

The client's habit of signing a freshly typed amount from the category's
income/expense type is a data-entry convenience, not a server rule, and a
category can switch it off: `categories.auto_sign` is a nullable per-category
override (`null` inherits the nearest ancestor's, a root with none is on),
resolved into the read-only `effectiveAutoSign` the same way `effectiveColor`
and `effectiveIcon` already are. The frontend's `signAmountByCategory`
(`frontend/src/lib/categoryUtils.ts`) is the one place that reads it.

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

### Cash flow Sankey: a transfer leg is a flow by scope and class

The Cash Flow Sankey report (`backend/src/built-in-reports/cash-flow-sankey.service.ts`,
arithmetic in `cash-flow-sankey-assembly.ts`) is the one surface that draws a
transfer leg as a flow. Its rules, from `docs/future-plans/sankey-cash-flow.md`:

1. **Scope is a set of cash-flow accounts.** By default every open `CHEQUING`,
   `SAVINGS`, `CASH`, `CREDIT_CARD` and `LINE_OF_CREDIT` account (never an
   investment sleeve); the request may name any other set. Income and expenses
   are the rows of in-scope accounts.
2. **A transfer between two in-scope accounts is internal and invisible.**
   Neither leg passes the counterpart predicate. Leaving a savings account out
   of scope is how a reader sees saving as a destination.
3. **A leg from an in-scope account to an out-of-scope one is an outflow to a
   class decided by the counterpart's type:** `SAVINGS`, `INVESTMENT`, `ASSET`,
   `OTHER` are "Savings & investments"; `LOAN`, `MORTGAGE`, `LINE_OF_CREDIT` are
   "Debt payments"; `CHEQUING`, `CASH`, `CREDIT_CARD` are "Other accounts".
4. **A leg into an in-scope account from an out-of-scope one is an inflow** by
   the same classes: "From savings & investments", "Borrowed", "From other
   accounts".
5. **A credit-card payment is not a debt payment.** The spending it settles was
   an expense on the purchase date; with the card in scope the payment is
   internal, with it out of scope it is "Other accounts".
6. **Investment-generated cash legs are not flows.** `investmentExclusionSql` is
   on every branch, the transfer branches included (SANKEY-003).
7. **The diagram closes:** `income + inflows + deficit = expenses + outflows +
   unspent` in integer ten-thousandths, with at most one of `deficit` /
   `unspent` non-zero. Both are the arithmetic residual, never a transaction; a
   response where the identity fails is a 500, never a drawing (SANKEY-001).
8. **Uncategorized is a node.** Uncategorized income and uncategorized spending
   each keep their own side; a category nets within itself and sits on the side
   it nets to (a category whose net is unknown for want of a rate sits on the
   side its own type names, with a `null` figure).

A leg counts once, by its own account's scope and its own signed amount
(SANKEY-002); a transfer never enters income or expenses (INV-REPORT-003). A
leg whose counterpart the reader cannot see (deleted, never linked, or the
other owner's leg of a cross-owner transfer) is "Other accounts" under
"(unlinked account)", so the identity still closes.

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

**Storage orientation is not the same question.** The rule above is about a
transaction's own `exchangeRate` column. A row in `exchange_rates` is stored in
one orientation per pair -- `from_currency` sorting before `to_currency` --
written by `canonicalRateRow`
(`backend/src/currencies/canonical-rate.util.ts`), and every lookup resolves
either direction through `resolveFxRate`, so nothing reads the storage layout as
a statement about which way round the market quotes a pair (INV-FX-003).

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

**Whose rate.** A row that carries its own rate settled at that rate, so every
surface converts it at that rate -- the register, the realized-gains report and
the transaction-history KPIs alike. The market rate on the row's own date is
the fallback for a row carrying none (`resolveFxRate`, INV-FX-001), and the
surface says which of the two it used rather than leaving the reader with two
figures for one sale. A stored `1` between two different currencies is the
column's default, not a rate: it falls back like an absent one. INV-FX-002.

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

### The executed total is the fact; the per-share price is derived

A trade's `total_amount` is what it came to; `price` is a quotient of it and
carries the division's remainder, not the trade's meaning. So:

- A caller that supplies a total has it stored **as given** at 4dp, and the
  price derived from it at the price column's 10dp:
  `price = (total -/+ commission) / quantity`, the commission taken back out of
  an acquisition and put back into a disposal.
- A caller that supplies only a price has the total derived from the price, as
  before: `quantity * price + commission` on an acquisition, `- commission` on
  a disposal.
- A stored total is **never** re-derived from a stored price on an update
  unless the price, the quantity, the commission or the action is the field
  that changed -- a value difference against the stored row, not a field being
  present, because `InvestmentTransactionForm` resends every field.

Both directions live in `backend/src/securities/investment-amount.util.ts`
(`deriveInvestmentTotal`, `derivePriceFromTotal`, `resolveInvestmentAmounts`);
no call site spells the arithmetic out again. A source that carries a total
keeps it: MNY's row amount, QIF's `T`/`$`. INV-TRADE-001.

A sale of 141 shares for 820.9081 stored as 141 x 5.82 reports proceeds of
820.62 -- a third of a percent of a realised gain that never happened, on one
trade, before FX.

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
a ratio below one: a 1-for-2 reverse split is `ratio = 0.5`, halving shares and
doubling per-share cost. There is no separate reverse-split action, so any code
that special-cases "ratio greater than one" is wrong for half the inputs, and
nothing applies a ratio to a stored holding -- the position is re-derived from
the ledger the SPLIT row now belongs to (INV-HOLDING-001).

`holdings.service.ts` implements this correctly (`qty *= txQty`). Section 9
records where it is implemented additively instead.

### A daily change needs two adjacent closes AND a current one

Every surface that shows a security's day-over-day move reads the two most
recent rows of `security_prices` and subtracts. That pair is a daily move only
while both hold:

```text
adjacent   the gap between the two closes is under DAILY_PRICE_GAP_EXCLUSION_DAYS (7)
current    the NEWER close is under DAILY_PRICE_STALE_AFTER_DAYS (5) old, against
           the reader's own todayYMD()
```

`backend/src/securities/daily-change.util.ts` (`resolveDailyPriceChange`) is the
one place that decides both, and `daily-change.guard.spec.ts` fails a file that
pulls the two-most-recent window without calling it.

The second rule is the one that was missing. When no price row lands for a
security -- its provider skipped the symbol, its exchange was shut while others
traded, that one fetch failed -- the two most recent closes become the previous
session's and the one before it, and the delta is a real move of an earlier day.
Served under a "daily change" caption it reads as today's, and it repeats every
morning until a new price arrives. Checking only the gap between the two closes
does not catch it: two rows a day apart stay a day apart forever.

Four days is the widest a live feed goes quiet for a reason that is not
staleness (a Thursday close read on the Monday of a Good Friday weekend), which
is why five is the cut. A close dated *ahead* of the reader's day -- an Asian
session printing while a North American reader is still on the previous date --
is current, not stale.

What the surfaces do with a refusal differs, and each is the honest answer for
what that screen is:

| Surface | With a current move | Without one |
|---|---|---|
| Top Movers (`getTopMovers`) | ranks the holding | drops it: a movers list has no figure for it |
| Favourite securities (`getFavouriteSecurities`) | prints the change | keeps the price, reports the change as `null` |

Never 0 for the refusal. A zero change is a security that traded and held its
price, which is a different fact from one whose move nobody knows.

`priceDate` carries the session to the client, and the widgets caption
themselves with it (`Daily change · 6 Feb`), because a Friday close read on a
Saturday is still the day's move and the reader has to be told which day that
was.

### A board of movers is one session's

The age rule above is absolute, and an absolute age cannot separate a market
that was shut from a feed that skipped one symbol: both leave the same day-old
close behind. It has to let the shut market through, or every board would empty
out on a weekend -- so it lets the skipped symbol through too, and the holding
that did not price keeps its last real move at the top of a board captioned with
a day it was not measured on, every morning until a new price arrives.

What separates the two is the rest of the portfolio. `keepNewestSession`
(`backend/src/securities/daily-change.util.ts`) reads the session from the rows
themselves -- the newest `priceDate` any of them has -- and keeps only the rows
that carry it:

| The board's rows | Session shown | What happens to the rest |
|---|---|---|
| some priced today, one priced yesterday | today | the day-old holding is off the board: it has no move for the session being ranked |
| none priced today (a weekend, a holiday) | the newest they have | nothing: every row is that session's, and the caption says so |

`getTopMovers` filters through it before ranking, so the client receives one
session's rows and captions the board with their shared date. A row that
disagrees is a contract violation, and `TopMovers` drops back to the undated
`Daily change` wording rather than stamping one row's session onto another's
figures.

The rule is about a **ranked list of one day's moves**, not about a per-security
readout. The favourites watchlist is the per-security case: it is a fixed list
in symbol order, so each row prints its own dated change (`widgets.asOf`) and
nothing is ranked against anything. `getMonthOverMonthMovers` is a different
period entirely -- the last close on or before each month end, per security, by
design -- and does not filter.

### A period's value change is not what the portfolio earned

Over any window a portfolio reports three different figures, and collapsing
them into one reports a deposit as performance:

| Figure | What it is | Includes the reader's own money? |
|---|---|---|
| `valueChange` | `MV(end) - MV(baseline)` | yes |
| `netExternalFlows` | the cash that crossed the scope's boundary on `(baseline, end]` | it IS that money |
| `investmentResult` | `valueChange - netExternalFlows` | no |

A percentage belongs over the third and nowhere else. A security at 100 that
never moves, bought with 10,000 in January and another 10,000 in June, has a
value change of +10,000 and an investment result of exactly 0; the report that
divided the first figure by the January value announced a 100 per cent return
(issue #1392).

Which rows are external flow is **not** decided here: it is
`loadExternalFlowSubtotals` (`backend/src/securities/external-flow.util.ts`),
the classifier the daily movement notification already shares. A deposit, a
withdrawal and a transfer whose counterparty is outside the scope are external;
a dividend, interest, a buy, a sell and a transfer between two scoped accounts
are internal, and internal flows are return. Each day's subtotal converts at
**its own day's** rate -- January's deposit is January's money -- through
`resolveFxRate`, and a subtotal with no rate makes the whole flow unknown
rather than smaller (`FxAggregate`).

**The lower bound is exclusive.** `MV(baseline)` is the close of the baseline
day and already holds every flow that landed on it, so counting those again
subtracts them from a starting value that contains them.

**One boundary for both figures.** The flow is measured over the accounts whose
ledger cash `MV` values -- the cash sleeves and the standalone investment
accounts, `isValuationCashAccount` -- on both sides of a transfer, never over the
wider investment scope: a deposit posted straight to a brokerage row is a flow
the series cannot see, and subtracting it is a loss nobody made. A movement that
crosses that boundary without producing a countable flow (a trade settled
outside it, a split parent mixing an investment line with ordinary cash) is
counted per window and withholds `investmentResult` with the reason
`externallySettledTrade` or `mixedSplit`; the two figures either side of the
subtraction are still reported. These counts withhold the ACCOUNT result only:
the invested part's P&L, TWR and MWR are drawn around the securities and each
row's own amount, so where a trade's cash settled does not move them.

**A time-weighted return and a money-weighted one are two figures, not two
spellings.** The invested part reports both over the same flows and the same
days: `investmentReturnPercent` (`"twr"`, chained daily, the reader's timing
neutralised) and `investmentMoneyWeightedReturnPercent` (`"xirr"`, annualised,
each purchase, disposal and distribution weighted by its own date). They differ
wherever the reader invested more before a rise or a fall, and neither is a
correction of the other. A window under 30 days gets no annualised rate
(`windowTooShort`), a schedule with no single rate gets none at all
(`mwrUndefined`), and anything that withholds the P&L withholds both
(`docs/specs/portfolio-period-result.md` section 11).

**The return method is named on the wire.** `returnMethod: "simple"` divides
the period's result by the value it started with and ignores when each flow
arrived; it is neither Modified Dietz nor a time-weighted return, both of which
need a complete value on every flow date rather than only at the two
boundaries. The union exists so a later time-weighted figure arrives as a new
method rather than as the same caption meaning something else.

`decidePeriodResult`
(`backend/src/net-worth/portfolio-period-result.util.ts`) is the one place the
policy lives, `PortfolioPeriodResultService` reads the boundaries from the very
series the chart draws, and `docs/specs/portfolio-period-result.md` holds the
truth table, the numerical examples and the missing-data policy.
INV-PORTRESULT-001.

## 7. Scheduled occurrences

An occurrence may carry an override. `scheduled_transaction_overrides` is unique
on `(scheduled_transaction_id, original_date)`
(`uq_sched_txn_overrides_occurrence`, migration 168), so one occurrence has at
most one override.

That constraint used to name `override_date`, and the sentence above was drawn
from it as if the two were interchangeable -- they are not, and the conclusion
was false in both directions. `original_date` is the occurrence's identity;
`override_date` is where the override moved it. Keyed on the latter, two
overrides could replace one slot (the reader kept whichever row came first, so
row order chose the amount, category and date a posting used) while two genuinely
different occurrences could not be moved onto the same day. `createOverride`'s
SELECT-then-INSERT was the only thing between the API and the first state, and a
SELECT is not a lock.

```text
FIN-004
A stored override price is a decision the user made about that occurrence.
Reopening the editor must not replace it with the current market price. Applying
a fresh quote is an explicit action, never a side effect of opening a dialog.
```

Ten shares stored at 100.00 that come back as ten at 120.00 -- with the total
silently recomputed -- is a money field changed by nobody, and the user has no
way to tell it happened.

```text
FIN-005
`scheduled_transactions.amount` is a snapshot taken at whatever exchange rate was
current when it was written, not a description of what the occurrence will post.
For an FX-sensitive schedule -- a top-level investment, whose `amount` is the
security-currency cash impact, or a split parent carrying an investment line --
it stops describing the occurrence the moment a referenced security's or
account's currency changes.

The current amount is resolved, once, by
`ScheduledEffectiveAmountService.resolveMany`: the stored rate when its recorded
pair is still the settlement pair (because that is what posting will reuse),
otherwise a freshly resolved rate, and `null` when a genuine cross-currency pair
has no determinable rate. Every surface that presents or aggregates an
occurrence's cash amount reads that answer, in the settlement currency it names,
and reports `null` as unavailable. A total containing an unknown component is
`null` with the partial sum in a separately named field.
```

The persisted scalar is never the fallback. Substituting it turns "we do not know
what this will cost" into a confident wrong number -- 1,500 CAD for an occurrence
that posts 1,350 -- and it did so on five product surfaces at once while the
cash-flow forecast beside them was right (issue #1247).

Nor is the recurrence slot the due date. An override is addressed to a slot
(`original_date`, the occurrence's identity) and may move the occurrence to
another day (`override_date`); a surface that filters, sorts or prints the slot
announces a payment on a day the user has already changed. Both halves come from
one place -- `expandOccurrenceSlots` decides which occurrence, and
`ScheduledOccurrenceService` prices it -- because centralizing the arithmetic
alone left every consumer free to pick the wrong occurrence and be confidently
wrong about a number that was itself correct. INV-OCCURRENCE-003 in
`docs/system-invariants.md` records the enforcement.

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

## 9. Loan and mortgage interest

### The periodic rate is the nominal annual rate divided by the payments per year

Outside one legal exception, a loan or mortgage rate is quoted as a **nominal
annual rate compounded at the payment frequency**, so the rate charged per
period is `annualRate / periodsPerYear` -- `0.06 / 26` for a biweekly mortgage,
not `(1 + 0.06/12)^(12/26) - 1`.

The exception is the `CANADIAN_FIXED` mortgage type: a Canadian fixed-rate
mortgage must compound semi-annually by law, `(1 + r/2)^(2/n) - 1`. Every other
type uses the nominal convention, including a Canadian variable-rate mortgage,
which is an `ANNUITY` mortgage (`docs/specs/mortgage-types.md`, table 4.2).

The convention is a trait of the mortgage type (`accounts.mortgage_type`,
`NOT NULL DEFAULT 'ANNUITY'`): `MORTGAGE_TYPE_TRAITS` decides it once per layer
and every consumer asks `compoundingFor(type)` of the type `mortgageTypeOf`
reads. Every non-mortgage account carries the default, so a plain `LOAN` prices
as `ANNUITY`.

Both conventions are defensible and they disagree -- on 300k at 6% over 25
biweekly-paid years the difference is 0.68 on the installment and about 443 in
lifetime interest -- so the choice is a named contract, not a formula detail:

| Where | What implements it |
| --- | --- |
| Which convention a mortgage uses | `MORTGAGE_TYPE_TRAITS` / `compoundingFor` / `mortgageTypeOf` in `backend/src/accounts/mortgage-type.util.ts` and `frontend/src/lib/mortgage-type.ts`, held equal by the parity fixture `backend/src/accounts/mortgage-type-cases.json` |
| Backend rate | `getPeriodicRate(annualRate, periodsPerYear, type)` over `calculateStandardPeriodicRate` / `calculateCanadianPeriodicRate` in `backend/src/accounts/mortgage-amortization.util.ts` |
| Backend generic loan | `calculatePaymentSplit` / `calculateTotalPayments` in `backend/src/accounts/loan-amortization.util.ts` |
| Frontend projections | `getPeriodicRate` in `frontend/src/lib/loan-frequency.ts`, used by `frontend/src/lib/loan-schedule.ts` |
| Displayed EAR | `calculateEffectiveAnnualRate` (backend) / `effectiveAnnualRate` (frontend), keyed on the type and compounding at the **payment** frequency |

The displayed effective annual rate has to describe the rate the schedule
actually charges. Compounding at 12 regardless of the payment frequency named a
rate nothing in the app used: a biweekly mortgage charges `r/26` twenty-six
times, so its EAR is `(1 + r/26)^26 - 1`. `CANADIAN_FIXED` keeps
`(1 + r/2)^2 - 1` whatever its payment frequency, because that is the rate the
law defines.

Backend and frontend agreeing is **not** evidence for either convention -- they
deliberately mirror one formula, so parity can only detect drift, never a wrong
shared choice. The fixtures that hold this rule are derived independently of
both (`backend/src/accounts/mortgage-amortization.util.spec.ts`, "periodic-rate
convention"; `frontend/src/lib/loan-schedule.test.ts`). The two contract specs,
`backend/src/accounts/mortgage-type.contract.spec.ts` and
`frontend/src/lib/mortgage-type.contract.test.ts`, hold each layer's traits to
the shared parity fixture, and the backend one reconciles `MORTGAGE_TYPES` with
the `accounts_mortgage_type_check` CHECK in `database/schema.sql` both ways.

### The amortization method is a trait of the mortgage type

How a mortgage repays its principal is a trait of its type too, read through
`amortizationMethodFor(type)` from the same `MORTGAGE_TYPE_TRAITS` record, never
from a surface-local rule (INV-LOAN-007). Interest is
`roundMoney(debt(d) * r(d))` for every method, priced from the ledger debt and
the rate through the installment's own due date (INV-LOAN-006); only the
principal differs. `N` is `round(amortization_months * ppy / 12)`, `c` the
constant principal `roundMoney(P / N)`, and `remaining(d)` the scheduled
payments left counted from the calendar, never from the postings
(`docs/specs/mortgage-types.md` section 2):

| Type | Compounding | Method | Principal on due date `d` | `accounts.payment_amount` |
| --- | --- | --- | --- | --- |
| `ANNUITY` | nominal | annuity | the level installment minus the interest | the contractual installment |
| `CANADIAN_FIXED` | semi-annual | annuity | the level installment minus the interest | the contractual installment |
| `LINEAR`, `prepayment_mode` `SHORTEN_TERM` (or null) | nominal | linear | `min(c, debt(d))`; the whole debt on the final installment when the leftover is within `roundMoney(N * 0.005)` | null |
| `LINEAR`, `prepayment_mode` `LOWER_INSTALLMENT` | nominal | linear | `roundMoney(debt(d) / remaining(d))`; the whole debt on payment `N` | null |
| `INTEREST_ONLY` | nominal | interest only | 0; the whole debt (the bullet) on payment `N` | null |

A LINEAR or INTEREST_ONLY mortgage has no constant payment, so the column a
constant payment would occupy is null, held by a table CHECK, and every surface
that shows "the payment" shows a dated installment instead: the next
occurrence's, or a projected row's, with its date, and for INTEREST_ONLY the
bullet beside it. An extra repayment shortens a SHORTEN_TERM loan and lowers a
LOWER_INSTALLMENT loan's principal from the next due date; a rate change moves
only the interest of either. Accelerated frequencies are defined as a fraction
of the annuity's monthly installment and are refused for both new methods.

| Where | What implements it |
| --- | --- |
| The method of a type | `amortizationMethodFor` in `backend/src/accounts/mortgage-type.util.ts` and `frontend/src/lib/mortgage-type.ts` |
| The principal on a date | `methodPrincipal` / `nonAnnuityInstallment` in `backend/src/accounts/mortgage-installment.util.ts`; `methodPrincipal` in `frontend/src/lib/mortgage-installment.ts` |
| Preview | `calculateMortgageAmortization` in `backend/src/accounts/mortgage-amortization.util.ts` |
| Scheduled installment | `ScheduledTransactionLoanService.resolveInstallment` (`backend/src/scheduled-transactions/scheduled-transaction-loan.service.ts`) |
| Frontend projection | `generateLoanSchedule` in `frontend/src/lib/loan-schedule.ts`, over `frontend/src/lib/loan-schedule-methods.ts` |

The figures are fixed by the worked example in `docs/specs/mortgage-types.md`
section 7, computed independently of both layers; each truth-table row there
names the test that asserts it.

### The first payment date is payment number 1

`accounts.payment_start_date` is the date of the **first** payment (the loan and
mortgage forms label it "First Payment Date"), so a schedule of N payments
advances only N - 1 intervals to reach its last one: 12 monthly payments from
2026-01-01 finish on 2026-12-01. `calculateEndDate` and
`calculateMortgageEndDate` own this, and the linked scheduled transaction's
`endDate` is derived from their answer -- so an off-by-one there dates every
displayed payoff, and the scheduler's own end, one full period late.

### The last payment is a residual, and the count that reaches it is derived

A whole payment count is a ceiling: the payment that clears the balance is the
remaining balance plus that period's interest, and it is normally smaller than
the installment. Lifetime interest therefore comes from
`calculateResidualPayoff`, never from `paymentAmount * totalPayments -
principal` -- that arithmetic bills a full installment for a partial period
(569 too much on a 25-year accelerated-biweekly mortgage) and disagrees with the
period-by-period schedule the same app shows afterwards.

A count *supplied* by a caller is a ceiling in the same way: an installment large
enough to clear the balance sooner makes it too high, and one that never covers
the interest makes it meaningless. So `calculateResidualPayoff` derives the
effective count itself with `paymentsToClear`
(`backend/src/accounts/amortization-count.util.ts` -- one implementation of
`n = -ln(1 - P*r/A) / ln(1+r)`, which had three) and returns it, so
`totalPayments`, `endDate` and the totals all come from one number. A
non-amortizing installment yields `-1` for all three, and the payoff date falls
back to the far-future sentinel, rather than a precise figure for a schedule with
no end.

The count's own spelling has to be real, too. `accounts.payment_frequency` holds
whichever enum wrote it -- the mortgage path's `SEMI_MONTHLY` or the loan-payment
setup dialog's `SEMIMONTHLY` -- and a value neither `getPeriodsPerYear` nor
`advanceDate` recognizes falls silently through to monthly: twice the interest per
period, and rows dated a month apart. Both spellings are handled on both layers,
and two scans hold it (`backend/src/accounts/loan-payment-frequency.guard.spec.ts`
reads the DTO's `@IsIn` list, `frontend/src/lib/loan-frequency.guard.test.ts` reads
the dialog's options), because each reaches its engine through a cast.

Two domains, so two tables and one conversion, all declared as data and all in
`backend/src/accounts/payment-frequency.util.ts`:
`LOAN_FREQUENCY_TO_RECURRENCE` and `MORTGAGE_FREQUENCY_TO_RECURRENCE` are
`Record`s over their unions (adding a frequency without deciding how it recurs is
a compile error), `SCHEDULED_FREQUENCY_BY_PAYMENT_FREQUENCY` is their merge for
the one service that receives both, and `toMortgagePaymentFrequency` converts a
recurrence spelling into the mortgage domain -- returning `null` for `QUARTERLY`
and `YEARLY`, which a mortgage in this model has no cadence for, so the caller
refuses rather than computing a confident wrong split. A cast in place of that
conversion split a semi-monthly Canadian mortgage at twice the correct interest
for the life of the loan.

**A module-level merge of two tables must not be able to run before both exist.**
Those tables started out in the two amortization utils, which then had to import
each other. Under a mortgage-first load order the spread ran while the mortgage
module was still initialising and `SCHEDULED_FREQUENCY_BY_PAYMENT_FREQUENCY` came
out holding only the loan keys -- so an accelerated-biweekly mortgage fell to the
caller's `?? "MONTHLY"` and its scheduled transaction was created monthly. A
completeness assertion cannot see that (by the time a test runs, everything is
loaded), so the guard requires the modules in the hostile order in a fresh
registry: `loan-payment-frequency.guard.spec.ts`, "payment-frequency module has
no import cycle". The neutral module is the fix; the guard is what keeps it.

The same list is what the account can store, so it is also what the form may
offer: `PAYMENT_FREQUENCIES` in `frontend/src/types/account.ts` is one runtime
list with the type derived from it, and `AccountForm`'s Zod enum is built from it.
That is not tidiness -- `optionalEnum` maps an unlisted value to `undefined`, so a
form list missing a frequency the backend stores would silently ERASE it the first
time anybody edited such an account.

### A payoff date is a date the scheduler reaches

`endDate` on a loan or mortgage exists to bound the linked scheduled transaction,
so it is stepped by `calculateNextDueDate` -- the recurrence engine that will post
those payments -- and not by a calendar of its own. `calculateEndDate` and
`calculateMortgageEndDate` convert through the frequency tables above and call
`advancePaymentDates`.

The same reasoning reaches the *projection*, and for every cadence rather than
semi-monthly alone: a borrower reads projected row dates and posted dates as one
calendar. `advanceDate` in `frontend/src/lib/loan-schedule.ts` therefore delegates
to `advanceByFrequency` through one `Record`
(`SCHEDULE_FREQUENCY_TO_RECURRENCE`), the browser-side twin of the two backend
tables. It used to spell the rule out instead, to keep the file out of the
scheduled-transaction domain of `frequency.guard.test.ts`, and only semi-monthly
was ever aligned: the month cadences stepped with `Date.setMonth(+1)`, which
overflows rather than clamps, so a loan paid on the 31st had its second projected
row dated 3 March -- February skipped -- while the backend's `calculateEndDate`
clamped to 28 February. Avoiding a guard's domain is not a reason to keep a
second calendar; the switch became a `Record` (as did `getPeriodsPerYear` and
`overpaymentsPerYear`), so the file is in that guard's scope and passes on its
merits. `loan-frequency.guard.test.ts` walks every cadence against
`advanceByFrequency`, month-end anchors included.

A hand-rolled semi-monthly step (the 1st and the 15th) against the engine's own
(the 15th and the last day of the month) dated payment 24 of a 24-payment
schedule *before* the final installment, so the schedule it bounded posted 23 of
them. It follows that month-end drift in a payoff date is whatever the
scheduler's drift is, by construction -- which is the only answer that keeps the
two consistent, and is now also what a *projection's* row dates do, since
`advanceDate` steps through the same engine.

A `Date` carrying a calendar date is UTC-midnight throughout these helpers, the
convention `ensureYMD` and `formatDateYMD` already share: every caller builds one
from a date-only string and every consumer reads it back in UTC. Reading LOCAL
components in between put every payoff date one day early outside UTC, by two
routes -- west of Greenwich the input read landed on the previous day, east of it
the local-midnight output did -- and CI's `TZ=UTC` cannot see either. Setting
`process.env.TZ` inside a Jest worker does not move `Date`, so
`backend/src/accounts/payment-frequency.timezone.spec.ts` walks the offsets in
child processes and scans the three helpers for a local accessor.

A negative count is unknown, not "at most one payment": `-1` is the sentinel
`calculateResidualPayoff` returns for a schedule it could not work out, and both
date helpers answer it with the far-future sentinel rather than the start date.
The dateable ceiling is one exported constant (`MAX_DATEABLE_PAYMENTS`) that the
helpers and `createLoanAccount`'s own guard compare against the same way, since
two literals disagreed at the boundary.

### A projection horizon is derived from the frequency, and a truncated total is unknown

`frontend/src/lib/loan-schedule.ts` projects at most
`DEFAULT_MAX_PROJECTION_YEARS` (50) years of payments, which is `periodsPerYear
* 50` rows -- 600 monthly, 1300 biweekly, 2600 weekly. A flat 600-payment cap
was not a horizon but a monthly-only one, and it cut ordinary 25- and 30-year
weekly and biweekly mortgages short. A 30-year weekly mortgage of 300k at 5%
runs 1560 payments and costs 279,367.53 in interest; stopped at 600 it reported
no payoff date, 232,723.84 still outstanding, and 155,557.54 of interest --
omitting 44% of the lifetime figure under a total's label.

When a schedule stops because it hit the horizon (`paidOff === false`), its
accumulated interest is the interest over that horizon, not the loan's lifetime
interest -- and its `numPayments` is a row count, its `payoffDate` is absent, and
its `finalPaymentAmount` is the installment at a mid-schedule row rather than at
its last payment. Per `docs/financial-calculation-contract.md` section 1 those
are subtotals: `LoanScheduleResult` carries them, and every consumer presenting a
lifetime figure, or a saving derived from one, gates on `paidOff` first.
`compareSchedules` returns `null` for all four of `interestSaved`,
`paymentsSaved`, `monthsSaved` and `installmentReduction`;
`PastImpactResult.interestAlreadySaved` and `monthsAlreadySaved` are `null`; the
goal-seek solver refuses a target it cannot prove was met; and both loan reports
withhold the projected payoff date and relabel the interest figure rather than
leaving "Est. Total Interest" over it.

Gating one of a set and leaving its siblings is the trap: `monthsSaved` came back
`0` from `monthsBetween(null, ...)`, which reads as "the overpayment bought no
time" rather than "not known", and sat next to an honest "Interest Saved:
Unknown" on the same card.

### A recurring overpayment cadence is a calendar, not a payment interval

A monthly overpayment happens twelve times a year on any loan. Deriving a fixed
payment interval instead (`Math.round(periodsPerYear / overpaymentsPerYear)`)
made "100 monthly" land every second biweekly payment -- thirteen times a year,
8.3% more cash than the borrower said they would pay, and interest savings
overstated to match.

So occurrences are dated: they fall on the cadence anchor (the overpayment's
start date, never before the first projected payment) and every cadence step
after it, and each one is applied at the first loan payment on or after its due
date. Each is derived from the anchor **by index**, not accumulated from the one
the one before it, on the recurrence engine -- the same calendar the loan's own
payment rows walk. Deriving each occurrence from the anchor by index kept a 31st
anchor on month-end (31 Jan, 28 Feb, 31 Mar, 30 Apr) while the rows accumulated
the engine's clamp (31 Jan, 28 Feb, 28 Mar, 28 Apr), so the occurrence due 31
March arrived after the 28 March row and the year paid eleven. (Earlier still,
`advanceDate` overflowed -- 31 January to 3 March -- losing February outright.)
The cost of the accumulating step is that a 31st anchor settles onto the 28th
after its first February rather than returning to month-end; on a loan whose own
payments have settled there it is no cost, and below the 29th the two are
identical. The count per calendar year is the invariant and survives both. `recurringOccurrencesDue` in `frontend/src/lib/loan-schedule.ts` is the
only place that decision is made, and it makes the cadence exact in both
directions: `MONTHLY`, `QUARTERLY` and `ANNUALLY` are calendar cadences, so they
contribute exactly 12, 4 and 1 occurrences per calendar year on a weekly,
biweekly or monthly loan; `WEEKLY` and `BIWEEKLY` are day cadences, so they
contribute one every 7 or 14 days -- 52 or 53 a year, exactly as a weekly
standing order does, rather than a levelled 52/12 per month that falls on no
payment date at all.

An occurrence is carried by the first loan payment on or after its due date, so
a cadence denser than the loan's payments arrives in batches (four or five
weekly occurrences on each monthly payment) and one due in late December is paid
by the January installment. That lag is the honest direction: interest is
charged for the days the money had not yet arrived.

`perPaymentExtraAmount` survives as a **display** average for the "resulting
monthly payment" card. It is not what the engine applies, and it must not be
used to compute a balance.

## 10. Gap register

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
test, per `AGENTS.md`: one that fails on any `: 1` else-branch beside a rate
lookup, any `?? amount` beside a conversion, and any `SPLIT` case outside the
single shared reducer. Prose has already been insufficient here more than once.

## 11. Rules recorded from `AGENTS.md`

Each of these was a paragraph in `AGENTS.md`; the one-sentence form stays there and the reasoning lives here.

### The amount is half the answer; the account is the other half

A scheduled investment's `accountId` is the brokerage, but the cash settles in the funding account or the brokerage's linked cash account -- so `settlementAccountId` (from `resolveSettlementAccountId`, the decision the posting makes) says whose balance the figure belongs to. An account-level projection keyed on the stored column charged the brokerage for cash it never moved *and* left the funding account's chart missing the outflow it pays: swapping only the amount would have traded one wrong number for another. Ask which account before asking how much.

### Ask which occurrence, then how much -- and its direction is part of "how much"

"An exchange rate is positive, so it cannot flip a sign" is true of one scalar times one rate and false of a **mixed-sign split parent**, where only the investment line re-prices: a parent stored at -200 posts +150 once that line moves. Three surfaces read the snapshot's sign, so AI/MCP called a re-priced deposit a bill, the forecast called an inflow an expense, and a SQL prefilter on `st.amount < 0` dropped the reverse case from the budget entirely. Direction comes from `EffectiveScheduledOccurrence.directionAmount` -- the occurrence's amount when known, and when it is not, the snapshot's sign **only where that sign is provable without the missing rate**: a top-level investment is one scalar times one positive rate, and a split whose lines all point the same way stays on that side of zero because an investment line's cash impact is signed by its action. A **mixed-sign** aggregate is where it is not provable and `directionAmount` is `null`: a +10 parent made of a fixed +100 beside an unpriceable BUY posts -20 at one rate and +20 at another, so both a red bill and a green deposit are inventions. `null` means unknown and travels -- AI/MCP report `kind: "unknown"` and withhold BOTH bucket totals, the reminder email draws a neutral badge, `occurrenceKind` answers `'unknown'`, and an outflow-only read KEEPS such an occurrence rather than dropping a possible payment behind a total that still looks complete. A candidate query may narrow on the stored sign only for shapes no rate can move; every FX-sensitive row stays in, and the direction is applied after pricing. `occurrence-selection.guard.spec.ts` fails a `Number(<anything>.amount)` compared against zero in any file that holds a resolved occurrence -- by shape, not by variable name, because the alias is how the last one got through.

### An account, its currency, its rate and its amount are one tuple

Persist all of it or none of it. Moving a transfer's destination leg to an account in another currency wrote the account, currency and new rate but left the old destination *number*, so the next recompute moved the balance with no user action behind it. Key the write on "did this edit re-price the transfer", never on which request fields happened to be present.

### A presentation-only edit does not re-resolve a rate

Resolve FX only when the financial structure changes: either account, the source amount, an explicit destination amount, an explicit rate. A rename or date correction is not a re-pricing; the rate a transfer settled at is a fact about the transfer (renames used to store today's rate beside an unchanged destination amount, and refused outright when the pair had no current rate).

### A clamp bounds the total, not one of its parts

Two children retiring one debt are clamped together. The loan final-payment fix capped the amortized principal but not the extra-principal transfer beside it, so the account crossed zero into credit and the payoff check never fired. Decide which part yields (the amortized figure is owed; the discretionary extra absorbs the shortfall) and write the yielding part back -- shrinking the parent while a child carries the unclamped number fails the split validator's exact-4dp equality.

### The fix for one surface is not the fix

Issue #1167 taught the cash-flow forecast to re-resolve and left the same decision duplicated in the dashboard, the budget, the reports, the exports, the AI assistant, MCP, the bill reminder, the alert and the account balance projection -- so one schedule read 1,500 CAD on five screens and 1,350 CAD on the forecast that predicts its posting (#1247). When you fix a derived-figure defect, grep every consumer of the raw field in the same commit and give them all one server-authoritative answer; `frontend/src/lib/scheduled-effective-amount.guard.test.ts` is the scan that keeps them there. INV-OCCURRENCE-003 in `docs/system-invariants.md` records the contract.

### Centralizing the arithmetic is not centralizing the answer

The first pass at #1247 gave every surface one resolver and left each of them to decide *which occurrence* it was pricing: the identity is a recurrence slot (`original_date`), an override can move the occurrence to another date (`override_date`), and a consumer that keys the lookup on the moved date -- as the budget alert path did -- silently reads the template for every occurrence the user changed. So the unit a surface asks for is the **occurrence**, from `ScheduledOccurrenceService` (`backend/src/scheduled-transactions/scheduled-occurrence.service.ts`) and its one expander (`backend/src/common/scheduled-occurrences.ts`): amount, currency, completeness, the date it falls on, and the account whose balance it moves. `ScheduledEffectiveAmountService` stays the arithmetic beneath it, and a schedule-level read model (`findAll`) is the only place `base` is the question. `backend/src/scheduled-transactions/occurrence-selection.guard.spec.ts` fails a second expander, a second override lookup, a stray `base` read or a new resolver call site. **Ask which occurrence before asking how much.**

### VOID means no balance moved -- on every path that writes one

A `VOID` row records something that did not happen, and `recalculateCurrentBalance` excludes it -- so every incremental balance update must agree, on every path (create, status-only edit, bulk void, split parent). Two rows describing one movement of money share a status, and a reversal only reverses what was actually included.

The status is part of what a row is created *with*, not something applied after: when a create helper takes the parent's status, every caller passes it (three separate paths recreated a voided parent's transfer legs as ACTIVE by forgetting that argument).

Where two rows can hold *different* statuses -- a cross-owner transfer, whose status is deliberately per-ledger -- inclusion is decided per row. Using one leg's `wasVoid`/`isVoid` to gate both ledgers is wrong in two of the four combinations. Four states means a four-case test matrix, not a representative one.

### Editing one row must not leave the pair describing two different events

A split parent and the transfer legs its children created are one movement of money, so voiding *one* leg from the target side is refused rather than applied -- refuse and point at the parent, which already has a propagation path. Only the VOID boundary is shared; reconciliation states (`PENDING`/`CLEARED`/`RECONCILED`) are genuinely per-ledger.

A refusal is only worth as much as its least-guarded entry point: the same state was reachable through `bulkUpdate`. When you refuse something on one path, grep for the bulk, AI-action and MCP routes to the same write in the same commit.

### A deletion reverses only what the row actually contributed

A `VOID` row moved no balance, and neither did a future-dated one, so deleting either must move none. Nine hand-written reversal sites got this wrong four times (including checking VOID but forgetting the date). Call `deletionBalanceEffect` (`backend/src/common/deletion-balance.util.ts`); `deletion-balance.guard.spec.ts` fails on a new hand-rolled `-Number(row.amount)` reaching a balance update.

### A balance change is not finished until its derived state is invalidated

Writing the live balance and stopping leaves a stale net-worth snapshot until something unrelated touches the account. A helper that moves an account nobody upstream knows about must **return** the accounts it moved (`applyParentStatusToTransferCounterparts` returned `void`, so its callers invalidated only their own lists). Dispatch the recalculation after the commit, never from inside the transaction: a rollback must not leave a recompute queued for state that was never written.
