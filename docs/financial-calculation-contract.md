# Financial Calculation Contract

The canonical rules for any code that computes, aggregates, or reports money.
They exist because the most tempting implementation of a financial calculation
-- filter out the nulls, sum what remains, default the unknown to zero -- is
syntactically clean and financially wrong. Every rule below was extracted from
a real defect where that pattern produced a plausible but incorrect number.

This contract applies to both surfaces that expose a calculation (REST API and
AI/MCP tools) and to every layer in between. `docs/time-series-contract.md`
covers the time-dimension rules (historical prices, backtests, period returns);
this document covers point-in-time calculation semantics. Rounding and
precision rules live in `AGENTS.md` (Financial Math), with the per-currency
rule (`moneyDecimalsFor`, INV-MONEY-001) in `docs/financial-semantics.md`
section 4, and are not repeated here.

## 1. Missing values propagate; they do not disappear

A field named `total*`, `portfolioValue`, `transferValue`, `gain`, `loss`,
`tax`, `costBasis`, or `estimated*` may only contain a value when **every**
component required for that calculation is known.

- Filtering out `null` components and summing the remainder produces a
  **subtotal**, not a total. It must never be returned under a field whose
  name says "total".
- If any component is unknown, the complete-total field is `null`. If the
  partial sum is still useful, return it in a **separate, explicitly named**
  field. One field must never silently represent both a complete total and a
  partial subtotal:

  ```typescript
  // The pair of fields a consumer can trust:
  totalMarketValue: number | null;     // null unless every position priced
  knownMarketValueSubtotal?: number;   // sum of the priced positions only
  unpricedPositionCount?: number;      // why the total is null
  ```

- The same applies to derived values: a percentage, allocation weight, or
  average computed from an incomplete total is itself incomplete and must be
  `null`, not computed from the subtotal as if it were the whole.
- When a response carries an incomplete value, it must also carry enough
  information for the consumer to see *what* is missing (a count, a list of
  affected ids, or an `incomplete: true` flag) -- silence is what turns a
  subtotal into a lie.

### 1.1 A missing exchange rate is not a rate of 1

Rate `1` is reachable only when the source and destination currency codes are
equal. There is no other branch that may produce it, and in particular a failed
lookup may not: 1,000 USD reported into a EUR total as 1,000 EUR is an 11%
overstatement that is *numerically plausible*, which is what makes it dangerous.
A consumer given a bare number cannot tell a real 1:1 pair from an absent one.

A conversion has three outcomes and they stay distinguishable -- converted,
same-currency (no conversion needed), and unknown. Aggregate through `FxAggregate`
(`backend/src/common/fx-aggregate.ts`), which cannot silently absorb a missing
component: it records each unresolvable pair, and `total` is `null` while
`knownSubtotal` carries what did convert. Note that an aggregate nothing was added
to is `0`, not `null` -- an empty account holds zero.

Zero and negative are not rates either, and are treated as absent rather than
applied: multiplying by 0 reports a real holding as worthless.

`docs/specs/fx-conversion-completeness.md` has the invariants, the numerical
example table, the staged rollout of nullable response totals, and the recorded
decision on look-ahead before the rate history begins.
`backend/src/common/fx-fallback.guard.spec.ts` scans for a new silent fallback.

### 1.2 A currency code is a fact about an account, not a request field

A transaction's `amount` and `currencyCode` are the account-currency pair; a
foreign entry lives in `originalAmount` / `originalCurrencyCode` /
`exchangeRate`, which is what shows a mismatched primary code is not an
alternative supported shape. Derive the code from the account and reject a
request that names a different one -- `assertTransactionCurrencyMatchesAccount`
(`backend/src/common/fx-entry.util.ts`) is the single check.

The same holds for both sides of a transfer, and for a transfer's destination
amount:

- Same currency on both sides: the destination amount equals the source amount.
  No rate and no fee can make a same-currency transfer unequal, so an explicit
  destination amount that disagrees is a rejection, not an override.
- Different currencies: an explicit destination amount is honoured (a bank's real
  settlement figure legitimately differs from spot by fees) and its implied rate
  is stored; otherwise the rate is resolved server-side and a pair with no
  determinable rate is refused rather than posted at par.
- A preview resolves the rate the same way the commit does. A preview showing a
  figure the commit will not post is the same defect as a wrong figure.

A caller that stores only one side's currency -- a scheduled transaction -- sends
neither code and lets the service derive both. Sending a stored code risks it
having gone stale, which now fails the posting rather than corrupting it.

### 1.3 A withheld figure carries its repair

"This cannot be worked out because some data is missing" is not an answer; it
is the shape of one. Every figure a surface withholds owes the reader three
things, and a surface that gives fewer has not finished:

1. **What is missing, by name.** The security (its symbol, never its id), the
   currency pair, the account, and the dates the gap covers. The server
   already carries these -- `FxAggregate.missingPairs`, `unpricedSecurityIds`,
   `unknownCashAccountIds`, per-point `missingRatePairs` -- and the client
   resolves ids to names before printing them. A count alone ("3 positions
   unpriced") is a subtotal of an explanation.
2. **How the reader obtains it.** Each cause has one repair and the copy names
   it: an unpriced holding is a price to refresh or add on the security's
   price history; a missing rate is history to add on the Currencies page; a
   cash account with no balance for the day is a reload and, if it persists,
   a defect to report; a boundary (no earlier value to compare against) has no
   repair and says so. `UnknownAmount`'s `reason` on the client is the catalog
   of these repairs; a new cause is a new reason there, not a new sentence in
   a component.
3. **What the system tried first.** Where a provider can supply the missing
   observation, the read path fetches it before it discloses the gap: bounded
   (one calendar month per pair per call, a fixed number of months per
   request), best-effort (a provider failure is logged and the report renders
   with the gap still named, never a failed request), re-read from the
   database rather than patched in memory, and never invented (a pair the
   provider does not carry stays missing). `ExchangeRateService.ensureRatesForDate`
   is the fetch, and `AccountBalancesReportService.ratesForReport` the shape
   of a caller: compute what is unanswerable, fetch, re-read, disclose the
   rest. A cron, an LLM tool or an export takes the opt-out and reads only
   what is stored.

Two states are not missing data and must never be shown as it. A request
that has not answered is loading; a request that failed is a failure, named
as one with the invitation to ask again. A card that falls to "not enough
history" or "nothing to show" because its request was rejected makes a claim
about the portfolio it has no grounds for (`docs/frontend/api-and-cache.md`).

The test obligation follows the three parts: a spec per surface that every
server reason renders its own named cause (a table over the reason union, so
a new reason fails it until it has copy); a spec that the read path calls the
fetch once per missing unit and re-reads before it discloses; and a spec that
a rejected request renders as a failure, not as an empty result.

## 2. Cost basis and tax

Realized result is market value minus cost basis; tax applies only to gains.
When an operation sells multiple positions, the result is defined by this
truth table:

| Situation | Expected result |
| --- | --- |
| No securities are sold; the operation is funded only with cash | Realized result `0`, tax `0` |
| Every sold security has a known market value and a known cost basis | Compute the complete result |
| Any sold security lacks either its market value or its cost basis | Realized result `null`, tax `null` |
| Cash | Never contributes to realized gain or loss |

The pattern this table exists to forbid:

```typescript
// WRONG: computes a partial result and presents it as the result
// for the whole transaction.
positions.filter(
  (position) =>
    position.marketValue !== null && position.costBasis !== null,
);
```

A `0` and a `null` mean different things and must never be conflated: `0` is
a known result of zero (cash-only operation, break-even sale); `null` means
the result cannot be computed. Never default an unknown cost basis, price, or
tax input to `0` to keep a formula running.

### 2.1 The acquisition commission is part of the basis

What a position cost to acquire includes what it cost to acquire it. The linked
cash debit for a BUY is `quantity * price + commission`, and the basis a later
disposal is measured against is that same figure -- so 10 shares at 100 with 10
of commission is a basis of 1,010 and an average cost of 101.00, not 100.00.

Leaving the commission out understates the basis and therefore overstates every
gain and every tax derived from one: 10 of commission is 10 of phantom gain, and
1.90 of phantom tax at 19%. It propagates -- a partial sale relieves the
understated average, so every later disposal inherits it.

`acquisitionCost` (`backend/src/securities/investment-replay.util.ts`) is the one
place this is computed. It returns `null` when the row cannot say what the
acquisition cost: `price` is nullable, and folding that to `0` made an unpriced
import look like a free purchase -- the units joined the position, nothing joined
the basis, and the quantity reconciliation downstream then *passed* because the
units did add up. A row genuinely worth zero still says so, with an explicit `0`.

Commission on a disposal is different and already handled: `totalAmount` on a
SELL is net of it, so proceeds need no further adjustment.

### 2.2 A share-count replay is written once

`applyActionToQuantity` (same file) is the only place an investment action is
folded into a share count, and `SHARE_MOVING_ACTIONS` the only place the set of
share-moving actions is named. `quantity` means shares for most actions and a
**ratio** for `SPLIT`, which is the distinction the duplication kept losing:
seven separate replays existed, three added a split's ratio to the share count
instead of multiplying by it, and the same three omitted `ADD_SHARES` and
`REMOVE_SHARES` entirely. Each copy was internally consistent, which is why
nothing failed -- a post-split position read 40% light on every history chart
while the holdings page was right.

`backend/src/securities/investment-replay.guard.spec.ts` scans for a new
hand-rolled fold, in both the `case` and the `if` form, and for a quantity
derived from a multiplication outside the reducer.

## 3. Cash

Cash is a funding leg, not an instrument with a gain:

- Cash never contributes to realized or unrealized gain/loss.
- Cash is always "priced" -- a cash balance never makes a total `null`.
- Converting cash between currencies uses the exchange-rate rules of the
  operation's date; a missing exchange rate is missing data (rule 1), not a
  rate of `1`.

## 4. Valuation requirements

A calculation that needs a market value must state, and honour, where that
value may come from:

- A position without a usable price has `marketValue: null`, and rule 1
  propagates it. Do not substitute the purchase price, the last known price
  beyond the staleness bound, or zero.
- What counts as a "usable" price -- how recent it must be, and how close to a
  period boundary -- is defined in `docs/time-series-contract.md`.
- Multi-currency aggregation converts every component into the reporting
  currency before summing; a missing rate makes the affected component, and
  therefore the total, unknown.
- **A per-account market value that swallowed its own nulls must ship the count
  beside it.** `AccountHoldings.totalMarketValue` sums the priced holdings only,
  which makes an account holding nothing and an account nothing could be priced
  for look identical -- so a client could not tell a settled zero from an
  unknown. `unpricedHoldingsCount` on the same object is what carries rule 1
  across that boundary, and `buildLogicalAccounts` (frontend) reads the pair to
  decide whether an investment account's combined value is a number or `null`.
  Prefer emitting the total as `null`; where an existing consumer needs the
  subtotal, name the subtotal and ship the count with it rather than leaving the
  caller to guess.

## 5. Materialized derived results declare their inputs

Every materialized derived result -- stored signals, forecasts, cached
reports, snapshots, and any other persisted calculation -- must declare the
complete set of inputs that determine it (configuration such as cadence,
lookback, instrument and account selection; and the data it was computed
over).

- When any declared input changes, the old result must be **versioned,
  recomputed, or excluded**. Never silently reused.
- Results produced under different input revisions must never be combined
  into one aggregate, history, or simulation. A history that mixes revisions
  is not a history of anything.
- The practical mechanism is a configuration fingerprint (hash of the
  declared inputs) stored alongside each materialized row; a read that finds
  a fingerprint mismatch treats the row as stale.

## 6. `ON CONFLICT DO NOTHING` and read models

When an operation performs `INSERT ... ON CONFLICT DO NOTHING` and then
returns a read model, losing the insert race must not change what the caller
sees:

- After the insert attempt, **re-read the authoritative state** inside the
  same transaction and build the response from that fresh read.
- Never build the response from a snapshot loaded before the insert attempt
  -- the request that lost the race would return data missing the rows the
  winning request just inserted.

## 7. A rejected command must not already have written

Every check capable of rejecting a command -- ownership, scenario or tenant
identity, revision or fingerprint, precondition, request consistency, quota --
runs **before the mutation is committed, inside the same transaction and under
the same lock that protect the write**.

A response of `400`, `403`, `404`, `409`, or a validation failure states that
the change did not happen. It must therefore not have happened. The single
exception is an API that documents partial success as its contract; such an
endpoint must return **which** operations committed, and the rejection is then
not a rejection of the whole command.

The sequence this forbids:

```text
1. Mark strategy A's signal as executed.
2. Commit.
3. Discover that the request named strategy B.
4. Return 409.
```

What the caller sees:

```text
Signal belongs to strategy A.
The request supplies strategy B.
The API returns 409 Conflict.
The signal must remain unmodified.
```

An HTTP status does not undo a committed row. A client acting on that 409 --
retrying, showing an error, leaving the operation marked outstanding -- is now
working against a database that disagrees with it.

In practice:

- A **pre-check outside the transaction is not the check.** State can change
  between reading it and writing, which is the entire reason the write is in a
  transaction. Re-read and re-validate inside it.
- Where concurrency matters, validate **under the same lock** as the write, not
  merely in the same transaction. A check that ran before the lock was taken
  describes a world the writer no longer inhabits.
- A service must not return a success-shaped value, having mutated, and leave
  the rejection to a layer above it. By then the transaction has committed and
  the caller's only options are an apology or a compensating write. Push the
  expectation *down* into the operation instead: give it the caller's
  precondition as a parameter and let it refuse.
- Distinguish the refusal from the other outcomes in the return type. "No such
  row", "not yours" and "done" are different answers and collapsing two of them
  into `null` invites the caller to guess.
- When a post-read invariant fails, **rolling the transaction back is the
  default**, not an exceptional path.

### 7.1 Testing a rejection

A test asserting only the thrown error proves the API's manners, not its
atomicity. Assert both halves:

```typescript
await expect(command()).rejects.toMatchObject({ status: 409 });

const reloaded = await repository.findOneByOrFail({ id: signalId });
expect(reloaded.executed).toBe(false);
expect(reloaded.executedAt).toBeNull();
```

Reload through the real persistence path wherever that is practical. An
assertion against an in-memory mock shows the code did not call `save`; it says
nothing about whether a transaction committed, which is the invariant when the
validation and the write are separated by a commit boundary. Where transaction
or driver behaviour *is* the invariant, the test belongs in the integration
suite; a unit spec is enough where the question is only ordering.

Where the invariant depends on a lock, add the interleaved case:

```text
read -> competing write -> validation -> attempted mutation
```

and assert that the rejected command left nothing behind.

## 8. Testing requirements

"Add tests" is not sufficient for financial code -- a test written by the same
author as the implementation tends to confirm its assumptions. Every financial
calculation needs:

- **An edge-case matrix** covering, where applicable: no positions / one /
  many; all data known; only some data known; cash plus securities; multiple
  accounts and currencies; missing prices; stale prices; missing cost basis;
  simultaneous gains and losses; configuration changes; deleted or replaced
  instruments; concurrent requests; first-time materialization; and payloads
  that pass through the real validation pipeline (not hand-built objects).
- **Inputs from `docs/testing-contract.md`**, which names the classes that
  have broken this codebase before and their canonical values. Select the ones
  the code can actually receive; it is not a checklist to satisfy in full.
- **At least one adversarial regression test per formula**: a case where a
  naive implementation using `filter(null)`, a default zero, or stale-value
  carry-forward would produce a plausible but incorrect result -- and the test
  fails on it. If the naive implementation would pass the whole suite, the
  suite is missing its most important case.

### 8.1 A green suite after a behaviour change is a finding

If you changed what a calculation produces and **nothing failed**, exactly one
of two things is true: the change is a no-op, or the suite had no case for
that behaviour. Say which, in the change description, before moving on -- and
if it is the second, add the case in the same commit.

This is the cheapest check in this document and the one that catches the most.
A rule can be written down, read, agreed with, and violated in code all the
same; a suite that stays green while the arithmetic changes underneath it is
evidence rather than opinion.

### 8.2 A test you have never seen fail protects nothing

For each invariant you add, break it on purpose before trusting the test:
revert the fix in your working tree, run the named test, watch it fail,
restore the fix. Record in the change description **which test fails on which
input**.

Doing this is also how you discover that the guard you just wrote is testing a
misspelled symbol, an interface that no longer exists, or a branch nothing can
reach.

### 8.3 A fixture is a claim about production data

Before writing one, find the code that *produces* the data and check that your
fixture is a shape it can actually emit. Two failure modes, both of which
leave a suite passing over a defect:

- **A fixture the producer could never emit** -- a mock returning a field
  combination the driver or the collaborator never returns. Every branch that
  reads it is then green and unreachable.
- **A fixture that omits a shape the producer *can* emit** -- weightings that
  always sum to 1 where the storage format explicitly allows a remainder, a
  price series far sparser or denser than the query supplies, an identifier
  always present where the column is nullable. The formula is then only ever
  exercised on the easy half of its input domain.

Where the language can enforce this, let it: type mocked collaborators so the
compiler rejects a return shape the real method cannot produce.

### 8.4 A second figure inherits the first one's denominator

Adding a new reported number over an existing base -- another percentage over
the same total, another total over the same conversion -- adopts every known
defect of that base and republishes it under a new name the reader has no
reason to distrust. A pre-existing problem you decided not to fix stops being
pre-existing the moment you build on it. Fix it, or do not add the figure.

## 9. Specification before implementation

A financial feature of any substance starts from a short written design
document, approved before implementation, containing: the invariants, the
truth tables (like section 2), numerical examples, the missing-data policy,
versioning and recomputation rules, concurrency behaviour, and the test
matrix. A specification written after the code -- or grown out of review
findings -- documents decisions; it does not guide them. This is the
domain-level counterpart of the propose-first workflow in `CONTRIBUTING.md`.

**"Of any substance" means**: it computes or reports money, it materializes a
derived result, or it reads a time series. Not the size of the diff -- a
twenty-line change that puts a new percentage on a page is in scope, and a
large mechanical rename is not.

**The specification is the first commit of the change**, so its date is on the
record and a reviewer can read the invariants before the code meant to
implement them. A design document appended at the end is a summary, and a
summary cannot be wrong in the way a specification can -- which is the whole
reason for writing one.

## 10. Keep the prose and the code in step

These rules are worth only what the code and the documents agree on.

- A document that names an identifier -- a field, a flag, a helper -- is
  making a claim about the source. When you rename or remove one, grep the
  `docs/` tree and every `CLAUDE.md` in the same commit. A document describing
  a model that no longer exists is worse than no document: it gets read,
  believed, and built on.
- A comment or docstring asserting that **every** call site does something --
  "all writes take this lock", "every read goes through this helper" -- is a
  test, not a comment. Write the scanning test that enumerates them
  (`backend/src/backup/backup.service.spec.ts` and
  `frontend/src/test/ui-conventions.test.ts` are the worked examples). Such a
  claim is true when written and silently false at the first call site added
  afterwards, which is exactly when nobody re-reads the comment.

## 11. Rules recorded from `AGENTS.md`

### A weighting is in one currency or it is meaningless

Summing `quantity * nativePrice` across currencies weights holdings by exchange rate as much as by size. Convert every value into one common currency before weighting (which currency does not matter; that they share one does), through the same resolver everything else uses. An unpriced holding dropped from the weights makes the priced subset stand in for the portfolio: refuse the whole statistic (`null`) rather than report a subset's.

### A completeness flag nobody displays is not a completeness signal

Backend, AI adapter and MCP all carried `valuationComplete` while `frontend/src/types/investment.ts` omitted it, so the one surface users read rendered a subtotal under "Total Portfolio Value". Adding metadata to a response is half the change; the consumer that branches on it is the other half -- grep the frontend types for the interface in the same commit, and relabel a partial figure rather than leaving a total's caption over it.

Read the field defensively at the consumer (`=== false`, not `!`): during a rolling deploy, absent means "no information". And read the flag from the *same aggregate that produced the numbers on screen* -- a view that switches which aggregate it displays switches which completeness it trusts.

### A completeness flag covers every total it is documented to cover, on every surface

`fxComplete` claimed to describe all of `PortfolioSummary`'s `total*` fields while one aggregate's gaps went only to the log. Union every aggregate's gaps, and derive anything downstream (a rate, a ratio) only when its own inputs are complete. The flag must survive the trip to each consumer -- the compact LLM shape dropped it, so AI/MCP quoted a subtotal as settled; for a model, the human-readable summary line has to say so too.

The converse is equally wrong: **zero needs no rate.** Asking for one made an empty foreign account take the whole portfolio's totals down to "unknown".

Completeness has more than one cause: track each separately (`fxComplete`, `pricesComplete`) and give consumers one flag meaning "every component of every total is known" (`valuationComplete`). Nested totals need their own answer -- a per-account total converts into the *account's* currency, the top-level into the *user's*, two different conversion graphs, so a global flag cannot speak for a total it did not compute.

### A gain is a value less the cost of the same holdings

A portfolio's or an account's gain is the market value of the holdings that were valued less the cost of THOSE holdings: `gainMarketValue - gainCostBasis` (`PortfolioCalculationService.calculateHoldingsWithValues`, `accountTotals`). Charging an unpriced holding's cost against a value that never included it read a 50,000 cost with no price as a 50,000 loss (A26-M38): 100,000 priced at a cost of 80,000 beside 50,000 of unpriced cost printed -30,000 and -23.08 percent, where the valued part had gained +20,000 and +25 percent. A holding enters the gain only when both its value and its cost converted into the currency of the total; the cost left out is reported as `unpricedCostBasis`, `totalCostBasis` keeps every holding's cost for the basis card, and `valuationComplete === false` marks the gain and the return as figures over the valued holdings only, on screen, in the PDF and in the assistant's summary line.
