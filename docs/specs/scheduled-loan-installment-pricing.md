# Spec: scheduled loan installment pricing

Status: implemented on `claude/issue-1253-6e3rel`.
Governs: issue #1253 -- scheduled loan payment interest drifts from the
amortization report -- including the two residual findings from the audit of
the first proposed fix (PR #1254): a split resolved too early goes stale, and
a report anchored on today disagrees with a bill anchored on its due date.
Registered as INV-LOAN-006 in `docs/system-invariants.md`.

Sections 7 and 8 (the dated payment and the occurrence projection, issue
#1637) are specified ahead of the code: they are built by the tasks of
`docs/future-plans/dated-loan-payment-tasks.md` and registered as INV-LOAN-009,
`unenforced` until that list's acceptance task.

Read `docs/financial-calculation-contract.md` sections 1, 7 and 8, and
`docs/specs/account-balances-as-of.md`, before changing anything here.

## 1. The invariant

For a scheduled loan installment due on date `d`:

```text
debt(d)   = max(0, -(opening_balance + SUM(amount)
              over transactions WHERE account_id = loan
                AND (status IS NULL OR status <> 'VOID')
                AND parent_transaction_id IS NULL
                AND transaction_date <= d))
rate(d)   = latest loan_rate_changes row with effective_date <= d,
              else accounts.interest_rate
interest  = roundMoney(debt(d) * periodicRate(rate(d)))
principal = by the mortgage type's amortization method (below),
              through allocateLoanPayment's waterfall
```

The principal rule is the account's amortization method,
`amortizationMethodFor(mortgageTypeOf(account))` (`docs/specs/mortgage-types.md`
table 4.3, INV-LOAN-007); a `LOAN` account is an annuity:

| Method | `principal` | `payment` |
| --- | --- | --- |
| ANNUITY (`LOAN`, `ANNUITY`, `CANADIAN_FIXED`) | `payment - interest` | the template's amount, grown back toward `accounts.payment_amount` when a template is advanced; from B1 of the dated-payment plan, toward the payment dated at `d` and stepped into exactly when it newly applies (section 7) |
| LINEAR, `SHORTEN_TERM` | `min(c, debt(d))`, `c = roundMoney(P / N)`; the whole `debt(d)` on the final installment when `debt(d) - c <= roundMoney(N * 0.005)` | derived: principal + interest + any extra principal line |
| LINEAR, `LOWER_INSTALLMENT` | `roundMoney(debt(d) / remaining(d))`; the whole `debt(d)` when `remaining(d) <= 1` | derived, as above |
| INTEREST_ONLY | 0; the whole `debt(d)` (the bullet) when `remaining(d) <= 1` | derived, as above |

`remaining(d) = N - k(d) + 1`, where `k(d)` counts the calendar due dates on or
before `d` from `payment_start_date` through `calculateNextDueDate`: the third
input dated at `d`, and a count from the calendar, never of postings. For the
derived methods `accounts.payment_amount` is null and is not read. The rule is
`methodPrincipal`, called through `nonAnnuityInstallment`
(`backend/src/accounts/mortgage-installment.util.ts`); a template missing
`amortization_months`, `payment_start_date` or a known `payment_frequency`
declines, as an unmanaged shape does. A posting still never grows the parent
(section 3); `docs/specs/mortgage-types.md` section 5.2 says how a derived
installment that rose after a rate change reaches the template.

The ledger expression is the canonical as-of balance
(`docs/specs/account-balances-as-of.md` section 3, INV-BALANCE-001's source),
with the installment's due date in place of today. The periodic-rate rules are
unchanged: nominal annual rate over periods per year for loans and every
mortgage type but one, the semi-annual-compounding effective rate for a
`CANADIAN_FIXED` mortgage, `periodsPerYearForStoredFrequency` for the count in
both spellings of the frequency column. A mortgage's rate is
`getPeriodicRate(annualRate, periodsPerYear, mortgageTypeOf(account))`, keyed on
the type's compounding trait (`docs/specs/mortgage-types.md` table 4.1).

Both inputs are dated at `d`, for the same reason: a payment or a rate change
recorded for next month belongs to next month's installment.

Three sources are explicitly **not** inputs:

- **The previously stored split.** `next = prev_interest - prev_principal *
  rate` is algebraically equivalent to pricing from balance only at full
  precision; stored splits are money already rounded to 4dp, so the recurrence
  carries the discarded fraction into every later bill (the issue's 98.0101
  versus 98.0000).
- **`accounts.current_balance`.** It is a through-today read model and
  deliberately excludes future-dated rows, so after a future-dated payment
  posts it repeats the old balance and the old interest.
- **`accounts.interest_rate` alone.** Recording a rate change deliberately does
  not write that column -- it stays user-owned, settable only from the account
  edit form -- so it holds the OLD terms after any change entered through the
  rate-history UI. It is the *fallback* when no timeline row applies, never the
  first answer. `effectiveAnnualRateOn` is the rule, and its truth table
  (`backend/src/accounts/loan-rate-timeline-cases.json`) is asserted by both
  layers because they cannot import each other.

## 2. Where it is priced

The one pricing path is `backend/src/loan-installments/price-installment.ts`:
`resolveInstallmentCore` reads the dated debt, the dated rate and the
template's managed lines (`identifyLoanTemplate`), and the pure
`priceInstallment` prices them (the method principal, the interest, the
waterfall). `ScheduledTransactionLoanService.resolveInstallment` delegates to
the core for the first three consumers below and keeps the posting path's
defaults; the template rewrite they share is `rewriteLoanTemplate`
(`backend/src/loan-installments/reprice-template.ts`), whose two halves
`planLoanTemplateRewrite` and `applyLoanTemplateRewrite` the rate-change
sync calls apart, so its preview and its write read one plan (section 7.5).
The core reads two
dated inputs from `loan_rate_changes`, through one function each:
`datedAnnualRate`, the rate at `d` (section 1), and, from B1 of
`docs/future-plans/dated-loan-payment-tasks.md`, `datedPaymentAmount` beside
it, the annuity payment at `d` (section 7.1). `resolveInstallmentCore`
calls both with the one `asOfDate` the consumer prices at, so a consumer that
prices through it dates both inputs or neither. The settlement calls the
pure tail with its own facts (`planLoanSettlement`,
`docs/specs/loan-installment-settlement.md`). Each one answered differently
is a reported drift:

| Consumer | Boundary `d` | When |
| --- | --- | --- |
| `recalculateLoanPaymentSplits` | the schedule's `next_due_date` (already advanced) | after each posting; writes the template for the next occurrence |
| `resolvePostingAllocation` | the occurrence's own due date | inside the posting transaction, under the parent lock, immediately before the financial write |
| `getLoanProjectionAnchor` | the schedule's `next_due_date` | on demand, for the amortization report's projection (`buildLoanProjectionInput`'s `anchor`) |
| `planLoanSettlement` (`backend/src/loan-installments/plan-loan-settlement.ts`, `docs/specs/loan-installment-settlement.md`) | the matched slot's due date, with the debt less the settlements planned earlier in the same rule pass | when a `settle_loan_installment` rule matches a bank row, inside the create's, import's or run's transaction, under the schedule row and `lockAccountsForBalanceWrite(source, loan)` |
| `LoanRateChangesService.buildScheduledUpdate` (purpose `sync`, section 7.5) | the schedule's `next_due_date` | after a rate change is created, edited or deleted, for the preview; inside `applyScheduledPaymentSync`'s transaction, under the schedule row lock, for the write the user confirmed |

Which schedule is "the loan's payment" is the account's own statement --
`accounts.scheduled_transaction_id`, written by the two paths that set a loan
payment up. Reaching instead for "any active schedule with a transfer split
into this loan" answers a different question: a standalone extra-principal
transfer is an ordinary configuration and, due sooner, would anchor the report
on an installment no bill will post. The fallback for a loan whose pointer was
never written accepts both spellings of the linkage (the top-level
`transfer_account_id` column and a split), because a plain scheduled transfer
into a loan carries no split.

The posting boundary is the date the occurrence's money actually moves --
`postDate`, which an override can move off the recurrence slot -- because that
is the date interest accrues to.
The settlement boundary is the slot the bank row pays, not the row's own
date: the bank charges the installment for its due date, however many days
the debit took (`docs/specs/loan-installment-settlement.md` decision 11). The
settlement prices through the same core, `backend/src/loan-installments/`
(extracted from `resolveInstallment` by B2 of
`docs/future-plans/loan-installment-settlement-tasks.md`), and refuses a
missing rate or cadence where the posting path defaults them.

The debt is read under the lock that authorizes the write, not merely inside
the same transaction (`CONC-001`). The scheduled-transaction row lock does not
serialize this: no ledger writer takes it, so a principal payment could commit
between the debt `SELECT` and the posting's own write and the split would be
priced from a balance already stale when it was written. The posting therefore
takes `lockAccountsForBalanceWrite` on the source and loan accounts before it
prices and holds it to commit -- the primitive every balance writer already
takes, which is what makes a concurrent ledger write queue behind it.
`scheduled-loan-pricing-concurrency.integration.spec.ts` proves the protocol
with two real connections; `pricing-lock.guard.spec.ts` proves the posting
takes it, because the integration harness stubs the scheduled module and cannot
construct the real `post()`.

The posting-boundary resolution is what makes the stored split safely a
**template**: a principal-only payment, void, delete or import committed
between occurrences changes what the next posting writes without any of those
mutation paths having to know about loan templates. When nothing moved, the
resolution reproduces the persisted amounts exactly (same balance, same rate,
same waterfall), so the common case is byte-identical.

## 3. What does not re-resolve

- **An inline amount or a stored override amount** is the user's explicit
  statement for that one occurrence and is posted as given. So is a figure the
  user typed in the Post dialog -- but "typed" has to be decided, not assumed:
  that dialog echoes the stored template back as *inline* splits AND sends the
  parent `amount` on every non-foreign post, so treating the presence of an
  amount as a user instruction made this whole path unreachable from the only
  surface that produces inline splits. An echo is recognised by value (each
  line against its `sourceSplitId`, the parent against the template's own
  amount); anything that differs is the user's statement. Without that, the
  dialog -- the path users actually take -- posts the stale allocation the
  auto-post path avoids, the same occurrence posting two different amounts
  depending on which button was pressed.

  The dialog pre-fills the template **booked in the currency's smallest
  unit** (issue #1581): the parent and every line rounded to it, the rounding
  difference on the principal line, so a 1,170.6458 template shows and sends
  1,170.65 = 864.59 + 306.06. That booking of the stored template
  (`bookTemplateAtMinorUnit`) is an echo too, compared exactly; there is no
  tolerance, so a cent the user moves between the lines is still their
  statement. Before this the dialog rounded only the parent and sent the 4dp
  lines, and the split validator refused every such post. The occurrence
  override editor and the template form load a template the same way
  (`bookSplitRowsAtMinorUnit`). Only a rounding difference is ever moved: a
  line set that did not sum to its parent at 4dp (an override that changed
  the amount and not the lines) is only rounded, and the split editor shows
  the gap for the user to place.

- **A posting is booked in the currency's smallest unit.** The allocation is
  priced at 4dp and booked by `bookLoanAllocation`: total and interest
  rounded to the unit, principal the remainder (the extra principal instead
  when principal is zero), never more principal than the debt.
  `docs/specs/mortgage-types.md` decision 7. A split template the pricing
  does not re-divide (no loan line, or an escrow line beside it) is booked by
  `bookTemplateAtMinorUnit` on the automatic path too, so no occurrence posts
  4dp from one button and cents from the other. An inline or override amount
  is the user's statement and posts as given.

- **A posting never grows the total.** The parent an occurrence posts is the
  bill the user was shown; re-pricing re-divides it between interest and
  principal. Only a template advancement may grow the parent back toward the
  account's configured payment (review #1131) -- doing that at posting time
  would move more money than any surface displayed. It may still *shrink*: the
  waterfall clamps principal to the debt that is actually left, so an
  occurrence retires the loan rather than overpaying it into credit.
- **A template shape the resolver cannot account for** (an escrow line, no
  identifiable interest line) declines -- the posting proceeds on the
  persisted amounts and the recalculation writes nothing, exactly as the
  recalculation has always declined, because repricing only the managed lines
  leaves the parent unequal to the sum of its children and the split
  validator then refuses every occurrence.
- **A ledger that cannot be read refuses.** It is not "this is not a loan
  template": returning null there would post the stale stored split, the exact
  defect this exists to prevent, so the posting rolls back and the anchor
  endpoint answers an error rather than the `{null, null}` the report reads as
  "no scheduled payment, project from today".

- **A debt already retired through the boundary posts NO money** -- for a
  template whose every line the payoff settles. The occurrence is still claimed
  and the schedule still advances, so nothing retries it; the recalculation
  then deactivates the schedule. Withholding the write is the point: the stale
  template still says 1,500, and charging it would record interest against a
  debt that no longer exists and push the loan into credit.

  Two carve-outs, and both matter:

  - **A template carrying a line the payoff does not settle still posts.** The
    debt check therefore runs *after* the shape is resolved, so it can say
    whether this is a bill this service accounts for end to end. Read the other
    way round, a mortgage template with an escrow, tax or insurance line
    reports the same "paid off" as a plain principal + interest one, and
    withholding its money silently stops paying the escrow.
  - **A LINE OF CREDIT stays active.** It is revolving: a facility at a zero or
    credit balance is not a finished loan, the user can draw on it again
    tomorrow, and deactivating its schedule is not recoverable from the UI.
    This matters since the debt became `max(0, -balance)`: an overpaid account
    in credit now reads as owing nothing, where the old `Math.abs` read a
    credit balance as fresh debt and kept amortizing it.

  `LoanPostingDecision` is what keeps this straight. "There is nothing to price
  here" and "the price is zero" are different instructions, and collapsing both
  into `null` is precisely how the retired case went on charging its whole
  stale installment.
- **FX schedules, transfers and investments** do not carry the loan template
  shape and never reach the resolver.

## 4. Report parity

`GET /scheduled-transactions/loan-anchor/:accountId` answers
`{ nextDueDate, debt }` -- the due date of the schedule the loan account names
as its payment (section 2), and `debt(nextDueDate)`. The Loan Amortization
Report fetches it inside the same request key as the loan's history (a failed
fetch reaches the report's error state; "no anchor" is not a fallback for an
outage) and hands it to `buildLoanProjectionInput`, so the first projected
row and the next bill are measured at the same date against the same balance.

Both the balance and the rate are now shared, so the first projected row and
the next bill agree on both inputs. Which surface passes the anchor is
enumerated by `frontend/src/lib/loan-projection-anchor.guard.test.ts` rather
than left to an optional argument nobody has to think about.

The **payment** is deliberately outside this: a rate change reaches the
schedule's installment through `LoanRateChangesService.applyScheduledPaymentSync`,
which asks the user first, so a declined sync leaves the bill at the old
payment by their decision. Interest is unaffected -- it is debt x rate. From
B1 of the dated-payment plan a declined sync holds the old payment only until
the advancement reaches the first installment the stated payment newly applies
to (section 7.3), because the payment is then read at each due date rather
than copied once.

Both fields null means the loan has no active scheduled payment; there is no
bill to be in parity with, and the projection keeps its today-anchored
fallback (`advanceDate(today)` against `history.currentBalance`).

**An OVERDUE anchor is refused, and falls back the same way.** "Behind us" is
a question about the **user's** calendar day, and the projection is passed one:
`todayYmd`, from `financialTodayYmd` (`frontend/src/lib/financial-today.ts`,
reached through the `useFinancialToday` hook), which prefers the stored
timezone preference and falls back to the browser zone -- term for term the
order `RequestContextInterceptor` uses to answer `todayYMD()` for the request
that priced the bill. `new Date().toISOString().slice(0, 10)` is a third
calendar belonging to neither layer: east of Greenwich it still reads yesterday
for the first hours after local midnight (fourteen at UTC+14) and west of it it
already reads tomorrow through the evening, so inside that window the report
accepted an anchor the bill had already marked overdue -- or refused one due
today. `frontend/src/lib/loan-projection-today.guard.test.ts` fails a projection
call that does not state its day, one that derives it any other way, and any
`toISOString()` day-slice in the module or its call sites.

The anchor's
debt is measured through the installment's own date, which is right while that
date is ahead and wrong the moment it is behind: everything the ledger did
after it -- a repayment, a draw, a rate change -- is real, is already on screen
in the history, and is invisible to a projection seeded from the older balance.
The generated rows would also be dated *before* history rows they are appended
after, so the schedule reads out of order. Reconciling an overdue schedule
properly means replaying each missed occurrence against the events that
followed it, which is a product decision about what an overdue bill means; the
honest interim answer is the one that predates the anchor, and the first row
then no longer matches the overdue bill -- a visible imprecision rather than a
confidently wrong balance path.

Which surfaces are anchored is enumerated by
`frontend/src/lib/loan-projection-anchor.guard.test.ts`, and the guard is the
authority: the **amortization report** and the **loan detail schedule table**
are bill-anchored, because both print per-installment interest and would
otherwise show two different figures for one payment. The Debt Payoff
Timeline and `useLoanProjection` stay today-anchored -- they project an
aggregate from where the borrower stands today and make no per-installment
parity claim.

## 5. Numerical examples

6% nominal, monthly (periodic rate 0.005), configured payment 1,500:

| Ledger through `d` | debt(d) | interest | principal |
| --- | --- | --- | --- |
| opening -200,000, nothing else | 200,000 | 1,000.00 | 500.00 |
| + principal-only +1,500 dated before `d` | 198,500 | 992.50 | 507.50 |
| + another +500 dated exactly on `d` | 198,000 | 990.00 | 510.00 |
| + 1,500 dated after `d` | unchanged | unchanged | unchanged |
| + a VOID row, any date | unchanged | unchanged | unchanged |
| + a split child dated before `d` | unchanged (its parent already counts) | | |

The issue's own rounding case: debt 19,600, stored splits -399.99 / -100.01.
The recurrence gives `100.01 - 399.99 * 0.005 = 98.0101`; the invariant gives
`19,600 * 0.005 = 98.0000`.

### 5.1 The dated payment: the fixture

The two timelines of issue #1637, the fixtures sections 7 and 8 and every task
of `docs/future-plans/dated-loan-payment-tasks.md` copy. `ANNUITY` (monthly
compounding), principal 100,000.00, 300 monthly payments, `payment_start_date`
2023-02-03, `accounts.payment_amount` 584.59 (the annuity payment of 100,000.00
over 300 months at 5.0 %, 584.5900), no standing extra. Recording the first
change writes the `initial` row 5.0 % / 584.59 effective 2023-02-03
(`insertInitialRowIfFirst`: the start date precedes the change). Interest is
`roundMoney(debt * 0.05 / 12)` before the first change and at the dated rate
after it; every figure is booked in cents (`bookLoanAllocation`: interest
rounded, principal the remainder), and the debt steps by the booked principal.
No 4dp interest figure in sections 5, 7 and 8 is a half-cent tie, so the
cents do not depend on the rounding mode.

### 5.2 Timeline A: a stated payment between two installments

4.5 % / stated 560.00 (`manual`) effective 2023-04-15. Nothing posted;
`next_due_date` 2023-02-03. The 2023-05-03 installment is the first the change
applies to: its preceding slot, 2023-04-03, is before 2023-04-15.

| Due | Payment | Interest | Principal | Debt before |
| --- | --- | --- | --- | --- |
| 2023-02-03 | 584.59 | 416.67 | 167.92 | 100,000.00 |
| 2023-03-03 | 584.59 | 415.97 | 168.62 | 99,832.08 |
| 2023-04-03 | 584.59 | 415.26 | 169.33 | 99,663.46 |
| 2023-05-03 | 560.00 | 373.10 | 186.90 | 99,494.13 |
| 2023-06-03 | 560.00 | 372.40 | 187.60 | 99,307.23 |

The rate-change sync after adding or editing this change leaves the template
at 584.59 = 416.67 + 167.92 (its own due date, 2023-02-03) and its preview
says the bill becomes 560.00 from 2023-05-03 (section 7.5). The defect this
replaces: the sync wrote 560.00 for 2023-02-03, so posting that occurrence on
its due date booked 560.00 = 416.67 + 143.33 where the contract is
584.59 = 416.67 + 167.92.

### 5.3 Timeline B: two stated payments, every installment posted on its due date

4.5 % / stated 557.00 effective 2024-05-15, 4.0 % / stated 531.10 effective
2025-06-15. Each installment is posted on its due date and the template
advanced after it (section 7.3).

| # | Due | Payment | Interest | Principal | Debt before | Why this payment |
| --- | --- | --- | --- | --- | --- | --- |
| 16 | 2024-05-03 | 584.59 | 405.86 | 178.73 | 97,406.35 | 2024-05-15 is after the due date: not yet in effect |
| 17 | 2024-06-03 | 557.00 | 364.60 | 192.40 | 97,227.62 | newly applies: preceding slot 2024-05-03 < 2024-05-15 |
| 29 | 2025-06-03 | 557.00 | 355.76 | 201.24 | 94,870.65 | 2025-06-15 is after the due date |
| 30 | 2025-07-03 | 531.10 | 315.56 | 215.54 | 94,669.41 | newly applies: preceding slot 2025-06-03 < 2025-06-15 |

## 6. Test matrix

- Unit (`scheduled-transaction-loan.service.spec.ts`): prior rounded splits
  deliberately inconsistent with the balance; the dated query bounded by
  `next_due_date` with its parameters asserted; posting-boundary resolution
  (stale template repriced, idempotence, decline on unmanaged shape, a
  `retired` decision on retired debt -- `LoanPostingDecision` keeps it apart
  from `not-applicable`, which posts the persisted amounts, so the two are
  asserted separately -- extra-principal line); `CANADIAN_FIXED` and `ANNUITY` mortgage
  rates unchanged; LINE_OF_CREDIT still supported; final-payment and
  extra-principal clamps unchanged; anchor endpoint shapes.
- Unit (`scheduled-transactions.service.spec.ts`): `post()` writes the
  ledger-derived allocation with the parent re-summed; posts the persisted
  amounts byte-identically when the ledger did not move; honours an override
  amount.
- PG integration (`scheduled-loan-dated-balance.integration.spec.ts`): the
  as-of SQL against a real database -- boundary inclusive, later rows
  excluded, VOID excluded, split children excluded -- through all three
  consumers.
- Frontend (`loan-history.test.ts`, `LoanAmortizationReport.test.tsx`): the
  anchored projection starts at the anchor's debt on the anchor's date and
  its first row's interest equals the bill's; `{null, null}` keeps the
  fallback; a retired anchored debt refuses the projection; the report calls
  the anchor endpoint inside the history request key; an anchor overdue in the
  user's zone is refused while UTC still reads yesterday, and one due today is
  kept while UTC already reads tomorrow.
- Frontend (`financial-today.test.ts`): the calendar day at pinned instants in
  named zones -- positive offset, negative offset, both extremes, and the
  browser fallback -- so a boundary case discriminates on any runner rather
  than only on one whose `TZ` happens to sit on the wrong side of it.
- Unit (dated payment, B1 to B3 of
  `docs/future-plans/dated-loan-payment-tasks.md`): every row of table 7.4 (the
  advancement and the settlement rows), 7.5 and 8.6 as a named case, the figures copied from this spec, not from
  the implementation's output; the shared `datedAnnuityPayment` asserted once
  for both callers (the advancement and the settlement); the sync's preview
  and apply asserted equal through one call; the projection's first
  occurrence asserted equal to `ScheduledOccurrenceService`'s amount for the
  same occurrence.
- PG integration (dated payment): the template advancement across a stated
  change on a real ledger (Timeline A, 2023-04-03 posted, the template read
  back at 560.00 = 373.10 + 186.90), and the sync's apply leaving
  `accounts.payment_amount` unchanged.

## 7. The dated payment (INV-LOAN-009)

Decisions 1, 2, 3 and 5 of issue #1637. The rate of an installment has been
dated since INV-LOAN-006; its annuity **payment** was not: the core read one
payment for every date (`max(template, accounts.payment_amount)` on
advancement, the template on posting), and the rate-change sync copied the
payment in force *today* into a template whose `next_due_date` may be years
earlier. This section dates the payment the way section 1 dates the rate.

### 7.1 The rule

For an annuity installment (`LOAN`, and the `ANNUITY` and `CANADIAN_FIXED`
mortgage types) due on `D`:

```text
row(D)      = the latest loan_rate_changes row of the account with
                effective_date <= D whose new_payment_amount is non-null,
                finite and > 0 (a tie on the date goes to the row read last
                over an ascending read, as effectiveAnnualRateOn)
payment(D)  = row(D).new_payment_amount     when row(D) exists
            = accounts.payment_amount        else, when it is > 0
            = null                           otherwise
statesBase  = row(D) exists and row(D).source <> 'initial'
total(D, E) = roundMoney(payment(D) + E)     when statesBase
            = payment(D)                     otherwise
```

`E` is the standing extra the purpose prices with (`priceInstallment`'s
`extraPrincipalAmount`). `statesBase` is the settlement's decision 12
(`docs/specs/loan-installment-settlement.md`): a `manual` or `inferred` row
states the base installment, which the rate-change sync writes with the
standing extra on top (`buildScheduledUpdate`: the payment plus the extra
line), while `accounts.payment_amount`, and an
`initial` row's verbatim copy of it, hold base plus extra as
`LoanPaymentSetupService` stores them.

A row that states a rate and no payment moves the rate from its date
(section 1) and leaves the payment to an earlier row: the two inputs are read
from the same rows at the same date, separately. A change effective
2024-05-15 first applies to the 2024-06-03 installment (table 5.3, row 17).
LINEAR and INTEREST_ONLY installments are derived (section 1's table), read no
payment, and a stated payment on their rate changes is refused
(`refuseStatedPayment`, `docs/specs/mortgage-types.md` 5.3), so this section
leaves them as they are.

**Mechanism (B1).** One pure function decides `payment(D)` and `statesBase`
for every consumer: `datedAnnuityPayment`, which the settlement already
prices with (`backend/src/loan-installments/plan-loan-settlement.ts`). B1
moves it into `backend/src/loan-installments/price-installment.ts` beside
`datedAnnualRate` (the planner already imports from that module, so the move
keeps the import one-directional) and adds `datedPaymentAmount`, the I/O half
that reads the account's rows as `datedAnnualRate` does.
`resolveInstallmentCore` reads both at `asOfDate`, and `priceInstallment`
takes the dated payment as an input instead of reading
`accounts.payment_amount` itself, so no purpose other than `reconfigure`
(7.2, and 7.6 item 3, by decision) reaches the undated column around the rule. The frontend projection already dates a stated payment the
same way: `generateLoanSchedule` (`frontend/src/lib/loan-schedule.ts`) applies
it to every row dated on or after its effective date.

`accounts.payment_amount` stays the contractual payment the rule falls back
to (decision 5). No rate-change path writes it (7.5).

### 7.2 What each purpose does with it

| Purpose | Annuity payment priced (total, extra included) | Before B1 |
| --- | --- | --- |
| `template` (advancement, section 2) | `total(D, E)` exactly when `newly(D)` (7.3); else `max(templateAmount, total(D, E))`; `templateAmount` when `payment(D)` is null | `max(templateAmount, accounts.payment_amount)` |
| `posting` | `templateAmount`: the bill shown, re-divided at the posting boundary (section 3) | unchanged |
| `settlement` | `total(D, E)` at the matched slot; null refuses `loan_not_configured`, missing `payment` | unchanged: already dated (settlement decision 12) |
| `reconfigure` | `accounts.payment_amount` when positive, else `templateAmount` | unchanged (7.6, item 3) |
| `sync` (the rate-change sync, 7.5) | `total(D, E)` exactly at `D` = the template's `next_due_date`; `templateAmount` when `payment(D)` is null; a rate nothing records declines rather than pricing 0 % | before B2: the payment in force today, priced at `max(effectiveDate, next_due_date)` with its own arithmetic |

The sync takes the dated payment exactly, not the `max`, because it exists to
correct a template the timeline no longer agrees with: a template left at a
payment the user has since stated down (Scenario 2 of #1637, 560.00 written
for 2023-02-03) would survive a `max` against a dated 584.59 only by luck of
direction.

### 7.3 The advancement steps into a new payment

```text
prev(D)  = the latest slot of the schedule's calendar dated before D: the
           calendar `occurrence-slots.ts` builds around next_due_date, with
           history stepped from start_date; none when D is the first slot
newly(D) = row(D) exists, row(D).source <> 'initial', prev(D) exists, and
           row(D).effective_date > prev(D)
```

An `initial` row never newly applies: it restates `accounts.payment_amount`
as it stood when the first change was recorded, and is dated the day before
that change when `payment_start_date` is null or not before it
(`insertInitialRowIfFirst`), so without the condition a first change that
states only a rate would make the column's own value replace a raised
template (row A16).

When the payment dated at the new `next_due_date` comes from a row dated
after the preceding slot, that row's payment newly applies to this
installment: it is the contract's figure for it, and the template takes it
exactly, down as well as up. Otherwise the `max` stands, because it is what
keeps two things the template legitimately holds above the dated payment: a
template the user raised (the extra principal they chose to pay through the
bill) and the grow-back after a final-installment clamp (review #1131, section
3). `prev(D)` is read from the slot calendar, which holds no posting date, so an
occurrence posted late or moved by an override does not change which
installment a change first applies to.

### 7.4 Truth table: the advancement

Fixture 5.1 with the timeline in the second column on top of the `initial`
row. Each row is the template `rewriteLoanTemplate` writes for `D` after the
installment due on `prev(D)` posted on its due date. Amounts in cents.

| # | Timeline beyond the `initial` row | Template before | `D` | `prev(D)` | `row(D)` | `newly` | Payment | Interest | Principal | Debt before |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A1 | stated down: 4.5 % / 560.00 eff. 2023-04-15 | 584.59 | 2023-05-03 | 2023-04-03 | 2023-04-15 | yes | 560.00 | 373.10 | 186.90 | 99,494.13 |
| A2 | as A1, one installment later | 560.00 | 2023-06-03 | 2023-05-03 | 2023-04-15 | no | `max(560.00, 560.00)` = 560.00 | 372.40 | 187.60 | 99,307.23 |
| A3 | stated up: 5.5 % / 610.00 eff. 2023-04-15 | 584.59 | 2023-05-03 | 2023-04-03 | 2023-04-15 | yes | 610.00 | 456.01 | 153.99 | 99,494.13 |
| A4 | rate only: 4.5 % / no payment eff. 2023-04-15 | 584.59 | 2023-05-03 | 2023-04-03 | `initial` 2023-02-03 | no | `max(584.59, 584.59)` = 584.59 | 373.10 | 211.49 | 99,494.13 |
| A5 | two changes between postings, both stated: 4.75 % / 572.00 eff. 2023-04-10, then 4.5 % / 560.00 eff. 2023-04-20 | 584.59 | 2023-05-03 | 2023-04-03 | 2023-04-20 | yes | 560.00 | 373.10 | 186.90 | 99,494.13 |
| A6 | two changes between postings, the later rate only: 4.75 % / 572.00 eff. 2023-04-10, then 4.5 % / no payment eff. 2023-04-20 | 584.59 | 2023-05-03 | 2023-04-03 | 2023-04-10 | yes | 572.00 | 373.10 | 198.90 | 99,494.13 |
| A7 | no change; the user raised the template to 600.00 before 2023-03-03, which posted 600.00 = 415.97 + 184.03 | 600.00 | 2023-04-03 | 2023-03-03 | `initial` 2023-02-03 | no | `max(600.00, 584.59)` = 600.00 | 415.20 | 184.80 | 99,648.05 |
| A8 | A7, then 4.5 % / 560.00 eff. 2023-04-15; 2023-04-03 posted 600.00 | 600.00 | 2023-05-03 | 2023-04-03 | 2023-04-15 | yes | 560.00 (the raise is replaced, decision 2) | 372.99 | 187.01 | 99,463.25 |
| A9 | final-installment clamp, no change: debt 300.00 at 5.0 % | 584.59 | any | any | `initial` | no | `max(584.59, 584.59)`, clamped by `allocateLoanPayment` to 301.25 | 1.25 | 300.00 | 300.00 |
| A10 | A9 written, then a void restores the debt before the A9 slot posts (it posts 301.25, re-divided); the debt at the next `D` is 10,000.00 | 301.25 | next | the A9 slot | `initial` | no | `max(301.25, 584.59)` = 584.59 (the grow-back) | 41.67 | 542.92 | 10,000.00 |
| A11 | A10 with 4.5 % / 560.00 dated after the A9 slot | 301.25 | next | the A9 slot | that row | yes | 560.00 | 37.50 | 522.50 | 10,000.00 |
| A12 | no `loan_rate_changes` row at all | 584.59 | 2023-03-03 | 2023-02-03 | none | no | `max(584.59, accounts.payment_amount 584.59)` = 584.59 (today's rule) | 415.97 | 168.62 | 99,832.08 |
| A13 | Scenario 2 data before any resync: the template holds 560.00 at 2023-02-03 and posted 560.00 = 416.67 + 143.33 (posting unchanged) | 560.00 | 2023-03-03 | 2023-02-03 | `initial` 2023-02-03 | no | `max(560.00, 584.59)` = 584.59 | 416.07 | 168.52 | 99,856.67 |
| A14 | A1 on a loan set up with a standing extra of 50.00: `accounts.payment_amount` and the `initial` row 634.59, the extra line and `accounts.extra_payment_amount` 50.00 | 634.59 | 2023-05-03 | 2023-04-03 | 2023-04-15 (`manual`: states the base) | yes | 560.00 + 50.00 = 610.00 (extra 50.00) | 372.54 | 187.46 | 99,343.51 (three postings of 634.59, each retiring its 50.00 extra) |
| A15 | no row; `accounts.payment_amount` 634.59 (setup stored base plus extra), extra line 50.00 | 634.59 | 2023-03-03 | 2023-02-03 | none | no | `max(634.59, 634.59)` = 634.59 (extra 50.00) | 415.76 | 168.83 | 99,782.08 (2023-02-03 posted 634.59 = 416.67 + 167.92 + 50.00) |

| A16 | `payment_start_date` null; the A7 template (600.00, 2023-02-03 posted 584.59, 2023-03-03 and 2023-04-03 posted 600.00); the first change is 4.5 % / no payment eff. 2023-04-15, so the `initial` row 5.0 % / 584.59 is dated 2023-04-14 | 600.00 | 2023-05-03 | 2023-04-03 | `initial` 2023-04-14 | no (`initial`) | `max(600.00, 584.59)` = 600.00 | 372.99 | 227.01 | 99,463.25 |

Table 5.3 is the same rule over a longer ledger: rows 17 and 30 are `newly`,
rows 16 and 29 are not yet in effect.

Asserted by: every row A1 to A16, and table 5.3's rows 16, 17, 29 and 30
through successive advancements, by `backend/src/loan-installments/price-installment.spec.ts`
("the dated payment: the advancement"), through `resolveInstallmentCore` on
the fixture's rows and calendar, in cents; `datedAnnuityPayment` and
`paymentNewlyApplies` by the same spec, once for every caller; `prev(D)` by
`backend/src/loan-installments/occurrence-slots.spec.ts` ("the preceding
slot"); row 17 and the A7 raise through the service's advancement by
`backend/src/scheduled-transactions/scheduled-transaction-loan.service.spec.ts`
("the advancement steps into a stated payment"); the step on a real ledger,
timeline and schedule (section 6's integration case) by
`backend/test/integration/dated-loan-payment.integration.spec.ts`.

The settlement reads the same dated payment at the slot a bank row paid
(7.2; `docs/specs/loan-installment-settlement.md` decision 12, whose 9.2 and
E16 cases stay its own fixtures). On fixture 5.1, each slot before it posted
on its due date:

| # | Loan | Slot | `row(slot)` | `statesBase` | Priced | Interest | Principal | Extra | Debt before |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| S1 | Timeline A | 2023-04-03 | `initial` 2023-02-03 | no | 584.59 | 415.26 | 169.33 | 0.00 | 99,663.46 |
| S2 | Timeline A | 2023-05-03 | 2023-04-15 (`manual`) | yes | 560.00 | 373.10 | 186.90 | 0.00 | 99,494.13 |
| S3 | the A14 loan (standing extra 50.00) | 2023-05-03 | 2023-04-15 (`manual`) | yes | 560.00 + 50.00 = 610.00 | 372.54 | 187.46 | 50.00 | 99,343.51 |

Asserted by: S1 to S3, and table 5.3's row 17 at its slot, by
`backend/src/loan-installments/plan-loan-settlement.spec.ts` ("the dated
annuity payment at the slot"), through `planLoanSettlement` on the fixture's
facts.

### 7.5 The rate-change sync (B2)

Decision 3 of issue #1637.

- **Priced at the template's own due date, never at the effective date.**
  The preview and the apply price through `resolveInstallmentCore` at
  `D` = the template's `next_due_date`, with the payment of 7.2's `sync` row.
  Mechanism: one function computes the plan
  (`LoanRateChangesService.buildScheduledUpdate`, over
  `planLoanTemplateRewrite` with purpose `sync`), and the apply calls it in
  the transaction that writes what it returned (`applyLoanTemplateRewrite`),
  so the preview and the commit cannot price two dates. A change dated after
  `D` does not move the payment at `D`, which stays the timeline's figure for
  `D`.
- **The figure at `D` is the timeline's, exactly.** It replaces whatever the
  template holds, a payment the user raised on the template included (the
  third row below): that is the price of repairing Scenario 2, where the
  template is wrong only by being lower than the timeline, and it is what
  today's sync already does (`buildScheduledUpdate` writes the timeline's
  payment with no `max`). The preview shows the current and the proposed figure side by side,
  so the user sees the raise go before confirming, and declining keeps it.
- **Applied through `rewriteLoanTemplate`, never `ScheduledTransactionsService.update`.**
  `applyLoanTemplateRewrite` writes the template's parent and its managed
  lines and nothing on the account, so the sync does not write
  `accounts.payment_amount` (decision 5). The schedule update writes that
  column when a template amount is edited, which is how Scenario 2 overwrote
  it; `loan-rate-changes.service.spec.ts` asserts the account row is not
  saved on any path, and its source-scanning case fails any reference to
  `ScheduledTransactionsService` from the rate-change module, whose Nest
  module no longer imports the scheduled-transactions one.
- **Create, update and delete all ask.** Each returns its
  `scheduledPaymentPreview` and applies nothing; the existing
  `POST /accounts/:accountId/rate-changes/apply-scheduled-payment` applies
  after the user confirms, recomputing through the same function. The
  mortgage rate update (`PATCH /accounts/:id/mortgage-rate`), which no UI
  confirms, calls that same apply at once after recording the change.
- **The preview names the due date.** `ScheduledPaymentPreview` carries
  `dueDate` (`D`, the installment the proposed figures are for) and
  `nextPaymentChange: { dueDate, paymentAmount } | null`: the first slot after
  `D` at which `newly` holds (7.3), and `total` there. Null when no row stating
  a payment is dated after `D`. The search is bounded: only rows dated after
  `D` can make a later slot `newly`, and each maps to the first slot on or
  after its date (`nextPaymentChangeAfter`,
  `backend/src/loan-installments/next-payment-change.ts`).

| Sync case | Template written (at `D`) | `nextPaymentChange` |
| --- | --- | --- |
| Timeline A added, nothing posted, `D` = 2023-02-03 | 584.59 = 416.67 + 167.92 | 2023-05-03, 560.00 |
| Timeline A edited (Scenario 2: the template held 560.00) | 584.59 = 416.67 + 167.92 | 2023-05-03, 560.00 |
| Timeline A added with the A7 template (600.00, 2023-02-03 posted 584.59, 2023-03-03 posted 600.00), `D` = 2023-04-03 | 584.59 = 415.20 + 169.39 on 99,648.05: the raise is replaced (current 600.00 shown beside it) | 2023-05-03, 560.00 |
| Timeline A, `D` = 2023-06-03 (2023-02-03 to 2023-05-03 posted per table 5.2) | 560.00 = 372.40 + 187.60 | null |
| Timeline A deleted, `D` = 2023-02-03 | 584.59 = 416.67 + 167.92 (the `initial` row) | null |

Asserted by: every row, Scenario 2's edit and the account row untouched on
every path by `backend/src/loan-rate-changes/loan-rate-changes.service.spec.ts`
("the scheduled-payment sync (spec 7.5)"); the `sync` purpose's rules by
`backend/src/loan-installments/price-installment.spec.ts` ('purpose "sync"');
`nextPaymentChange` by `backend/src/loan-installments/next-payment-change.spec.ts`;
the same on a real ledger, timeline and schedule by
`backend/test/integration/dated-loan-payment.integration.spec.ts` ("the
rate-change sync at the template's own due date").

### 7.6 Known gaps

Stated so they are not mistaken for coverage; none is closed by this work.

1. **A cursor moved without an advancement.** `skip()` and an edit of
   `next_due_date` move the cursor without `rewriteLoanTemplate`. When the
   skipped slot was the one a change newly applied to, the next advancement
   finds `newly` false and the `max` keeps the old payment where the stated
   one is lower (Timeline A: skip 2023-04-03, and 2023-05-03 bills 584.59).
   The projection (section 8) shows it; re-running the sync repairs it.
2. **An `initial` row outranks a later edit of the account's payment.** The
   `initial` row copies `accounts.payment_amount` when the first change is
   recorded, and by decision 1 a row stating a payment wins over the column.
   A payment raised later on the account form reaches the template only
   through the template edit (A7) or a new rate change.
3. **A method change re-levels the column, not the timeline.** `reconfigure`
   keeps targeting `accounts.payment_amount`, which a type change rewrites in
   the same transaction (`docs/specs/mortgage-types.md` 5.6); a row stating a
   payment under the previous type still dates the payment after it, and a
   later advancement takes `max(template, that row)`.
4. **An override with an amount and no lines.** `post()` writes its amount
   over the template's lines (section 3); the projection divides it at its
   due date (8.3). The override editor writes the lines with the amount.
5. **Existing data is not repaired** (decision 6). A template written by the
   old sync stays until the sync runs again (adding, editing or deleting a
   change and confirming, or the apply endpoint); A13 shows the advancement
   healing an overpaid-down template one installment late.

## 8. The occurrence projection (B3)

Decision 4 of issue #1637. Nothing on the server prices an occurrence of a
loan bill other than the next one, so the occurrence picker and the override
editor seed every date from the template's single amount. This read prices
each of the next `count` occurrences through the same core.

### 8.1 Contract

`GET /scheduled-transactions/:id/loan-occurrences?count=N`, under
`AuthGuard('jwt')`, `ParseUUIDPipe` on `:id`, the schedule read through
`withScopedDb` for the JWT's user; a query DTO bounds `count` to an integer
from 1 to 60 (default 12) with `whitelist` and `forbidNonWhitelisted`.

```text
{
  scheduledTransactionId: string,
  loanAccountId: string | null,
  status: "priced" | "not-a-loan" | "declined",
  currencyCode: string,
  occurrences: LoanOccurrence[]      // empty unless status is "priced"
}

LoanOccurrence {
  originalDate:   string             // the slot: the occurrence's identity
  dueDate:        string             // the date it falls on (an override's date)
  overrideId:     string | null
  amount:         number | null      // unsigned, booked in the minor unit
  principal:      number | null
  interest:       number | null
  extraPrincipal: number | null
  annualRate:     number | null      // the rate at dueDate (section 1)
  debtBefore:     number | null      // the folded debt at dueDate (8.2)
  complete:       boolean            // every figure above is known
}
```

`not-a-loan`: the schedule is not the template shape this core prices (no
transfer into a loan-like account); `declined`: it is, and
`identifyLoanTemplate` or `missingMethodTerms` declines it. In both the
client shows what the posting will move, which for those shapes is the
snapshot `ScheduledOccurrenceService` already answers.

### 8.2 The fold

Occurrences are `expandOccurrenceSlots` (`backend/src/common/scheduled-occurrences.ts`)
from `next_due_date`, with the schedule's overrides, `maxOccurrences = count`,
ordered by `dueDate`; the schedule's `end_date` and `occurrences_remaining`
bound it as they bound every consumer. With `debtLedger(x)` from
`datedLoanDebts` (one statement for every date, `backend/src/accounts/dated-loan-debt.util.ts`):

```text
debtAt(x)        = debtLedger(x) - sum(principal + extraPrincipal)
                   over the occurrences projected earlier whose dueDate <= x
chain(1)         = the template's amount (the cursor's bill as stored)
chain(k), k >= 2 = the advancement (purpose template, 7.3) at originalDate(k)
                   with templateAmount = chain(k-1), on debtAt(originalDate(k))
bill(k)          = the override's amount when occurrence k has one (8.3),
                   else chain(k)
lines(k)         = priceInstallment, purpose posting, with templateAmount =
                   bill(k), at dueDate(k) on debtAt(dueDate(k)), booked by
                   bookLoanAllocation
```

The fold is the settlement's (`planLoanSettlement`, settlement spec 7.2): the
ledger at each date less what the projection has already booked on or before
it, so a payment already recorded for a later date is counted at its date and
nothing is subtracted twice. Each occurrence is booked as the posting books it,
so its principal is what the ledger will hold. With no ledger row after
`next_due_date` this is `datedLoanDebt(next_due_date)` less the booked
principal so far.

An occurrence whose `debtAt(dueDate) <= 0.01` is the payoff `post()` writes no
money for (section 3): it is listed with `amount`, `principal`, `interest` and
`extraPrincipal` 0.00, and the projection ends after it, as the recalculation
deactivates the schedule.

### 8.3 An override

- An override with an amount and its own lines: the amount is the bill and the
  lines stand as given, identified by `identifyLoanTemplate`; its principal
  and extra fold. Lines `identifyLoanTemplate` does not identify leave the occurrence's lines
  null and `complete: false`, and every later occurrence `complete: false`
  with a null `amount`, because the debt after it is unknown.
- An override with an amount and no lines: the amount is the bill, divided by
  `lines(k)` at its `dueDate` (7.6, item 4).
- An override without an amount (a date move, a description): the bill is
  the template chain's, divided at the override's `dueDate`.
- An override never enters the template chain: `chain(k+1)` follows from
  `chain(k)`, because the advancement after an overridden posting
  (`rewriteLoanTemplate`) reads the stored template's amount, which an
  override does not write.

`overrideId` names it so the editor opens it.

### 8.4 Missing-data policy

| Missing | Response |
| --- | --- |
| The ledger cannot be read (`datedLoanDebts` answers null) | the read fails: 503 with `errors.scheduled.loanLedgerUnreadable` (the message the posting path already refuses with), never a guessed figure |
| No rate at an occurrence's `dueDate` or slot (`datedAnnualRate` null) | that occurrence and every later one `complete: false` with `amount`, `principal`, `interest` and `extraPrincipal` null; that occurrence still carries its `debtBefore`, the later ones null |
| An unknown cadence (`periodsPerYearForStoredFrequency` null) | every occurrence as for a missing rate |
| No dated payment for an annuity (`payment(D)` null) | none: the advancement keeps the template's amount (7.2), as it does today |
| The schedule is not found for the user | 404 |

The posting path's own defaults (0 % for a missing rate, 12 periods for an
unknown cadence, section 15 item 5 of the settlement spec) are not copied: a
projected figure the posting would compute from a default is a guess, and the
reader is told which date is unknown instead.

### 8.5 Count bound

`count` is at most 60 per request; the walk is bounded by
`OCCURRENCE_WALK_GUARD` and the ledger is read in one statement for every
date, so a request costs one schedule read, one override read, one rate read
and one ledger statement whatever its count.

### 8.6 Worked examples

Timeline A (5.2), nothing posted, `next_due_date` 2023-02-03, `count` 5: the
five rows of table 5.2 exactly, `complete: true`, `annualRate` 5.0 for the
first three and 4.5 for the last two. After the sync of 7.5 the first
occurrence's `amount` equals the stored template, 584.59.

Timeline A with an override of 2023-03-03 to an amount of 610.00 and no lines:

| `originalDate` | `overrideId` | Amount | Interest | Principal | Debt before |
| --- | --- | --- | --- | --- | --- |
| 2023-02-03 | null | 584.59 | 416.67 | 167.92 | 100,000.00 |
| 2023-03-03 | the override | 610.00 | 415.97 | 194.03 | 99,832.08 |
| 2023-04-03 | null | 584.59 | 415.16 | 169.43 | 99,638.05 |
| 2023-05-03 | null | 560.00 | 373.01 | 186.99 | 99,468.62 |

The 2023-04-03 bill is 584.59, not 610.00: the override is not the template.

Timeline A with the Scenario 2 template (560.00 at 2023-02-03, no resync):
the first occurrence is 560.00 = 416.67 + 143.33, what posting it would book,
and the second is 584.59 = 416.07 + 168.52 on 99,856.67 (A13). The projection
shows the defect rather than hiding it; the resync is the repair.
