# Spec: mortgage types

Status: implemented (P3-B1). Phase 1 (P1-B1 to P1-Q: the column, the traits,
the type-keyed consumers and the Select), the LINEAR and INTEREST_ONLY methods
with `prepayment_mode` on both layers (P2-B1, P2-F1), type detection (P2-B2,
P2-F2) and the contract migration (P3-B1: the column `NOT NULL DEFAULT
'ANNUITY'`, the two legacy flags dropped) are shipped, and every truth-table
row below names the spec that asserts it.
Governs: issue #1501 (tracking) and its sub-issues #1502 to #1514, agreed in
discussion #1486 in line with the direction set in #787. The plan is
`docs/future-plans/mortgage-types.md`, the task list
`docs/future-plans/mortgage-types-tasks.md`.
Registers INV-LOAN-007 in `docs/system-invariants.md` (status `unenforced`
at S1, `partial` from P1-Q, `enforced` from P2-Q) and extends INV-LOAN-003, INV-LOAN-004 and INV-LOAN-006.

Read `docs/financial-semantics.md` section 9,
`docs/financial-calculation-contract.md` sections 1, 7 and 8, and
`docs/specs/scheduled-loan-installment-pricing.md` before changing anything
here. This document is the authority the later tasks' fixtures are copied
from: a fixture that disagrees with section 7 is wrong, or this document is,
and the disagreement is resolved here first.

## 1. Scope

Two mortgage checkboxes ("Canadian Mortgage", "Variable Rate") become one
**Mortgage type**, and two amortization methods the engine lacks are added:
**linear** (constant principal) and **interest only**. Rate periods
(`loan_rate_changes`), extra repayments and principal/interest splits already
exist and are reused unchanged.

Out of scope: per-country profiles (#787 chose flexible basics instead), escrow
or insurance lines in a managed template (INV-LOAN-006 "Scope"), a
`CANADIAN_VARIABLE` type, linear or interest-only plain loans (`LOAN`
accounts keep the annuity engine in `backend/src/accounts/loan-amortization.util.ts`),
and accelerated frequencies for the new methods (section 6.4).

## 2. Definitions

| Term | Meaning |
| --- | --- |
| `P` | `accounts.original_principal`; for SHORTEN_TERM, null falls back to `abs(accounts.opening_balance)` (section 8). |
| `ppy` | Payments per year, `periodsPerYearForStoredFrequency(accounts.payment_frequency)`. |
| `N` | Scheduled payment count, `round(amortization_months * ppy / 12)`. |
| `r(d)` | Periodic rate on date `d`: `effectiveAnnualRateOn(d)` (INV-LOAN-006) turned into a per-period rate by the type's compounding trait (section 4.1). |
| `debt(d)` | The ledger debt through `d`, inclusive: `datedLoanDebt`, the canonical as-of sum INV-LOAN-006 already prices from. |
| `k(d)` | The number of calendar due dates on or before `d`: the calendar starts at `payment_start_date` (payment 1, INV-LOAN-005) and steps with `calculateNextDueDate` at `payment_frequency`. Defined for any `d`, including one off the calendar (a template whose next due date the user moved): 2025-07-10 on a calendar of firsts of the month has `k` 19, the same as 2025-07-01. |
| `remaining(d)` | `N - k(d) + 1`: the scheduled payments from `d` to the term end, `d` included. Derived from the calendar: the formula takes no count of postings as input, so a missed or extra posting does not move the term end. |
| `c` | The constant principal of a LINEAR mortgage, `roundMoney(P / N)`. |
| "installment" | principal + interest for one due date, excluding any standing extra-principal line. |

All money in this spec is at storage precision (`roundMoney`, 4dp, `MONEY_DECIMALS`
in `backend/src/common/round.util.ts`, mirrored by `roundMoney` in
`frontend/src/lib/format.ts`) and printed at cents. Section 3, decision 7
explains why.

## 3. Decisions

Decisions 1 to 6 were agreed in #1486; 7 to 11 are made here.

1. **Four types**, stored in `accounts.mortgage_type`: `ANNUITY` (default),
   `CANADIAN_FIXED`, `LINEAR`, `INTEREST_ONLY`. There is no
   `CANADIAN_VARIABLE`: a Canadian variable-rate mortgage computes identically
   to a plain annuity mortgage, so it is `ANNUITY`. The column's CHECK
   constraint is the only list the database accepts, and a contract spec
   reconciles it with `MORTGAGE_TYPES` in both directions (the
   `backend/src/common/db/rls-exempt-tables.spec.ts` pattern).
2. **Backfill**: a mortgage that was Canadian and not variable-rate under the
   two legacy flags became `CANADIAN_FIXED`; every other MORTGAGE row became
   `ANNUITY` (table 4.2); the contract migration gave every non-mortgage row
   the column default, `ANNUITY`. No existing account's payment, split or EAR
   changed, because the pre-type periodic rate took the semi-annual branch for
   exactly the `CANADIAN_FIXED` population.
3. **Term Length is shown for every type**, as the rate-fixed period (a UK fixed
   deal, a Dutch rentevaste periode, a German Zinsbindung). The renewal
   reminder (`backend/src/accounts/mortgage-reminder.service.ts`) reads
   `term_end_date` only and is type-agnostic, so it works for every type with
   no change.
4. **`prepayment_mode` is a per-account setting of a LINEAR mortgage**:
   `SHORTEN_TERM` (default, the Dutch standard, confirmed against ING by the
   requester: constant principal, the loan ends earlier) or
   `LOWER_INSTALLMENT` (principal re-derived as remaining debt over remaining
   payments, end date unchanged). Interest is on the reduced balance in both;
   a rate change moves only the interest. Truth table in section 4.3.
5. **Rate-change recalculation reads `debt(effectiveDate)`**, the as-of query
   the installment pricing uses. `recalculatePaymentForRate` and
   `buildScheduledUpdate` (`backend/src/loan-rate-changes/loan-rate-changes.service.ts`),
   and the mortgage rate update in
   `backend/src/accounts/loan-mortgage-account.service.ts`
   (`UpdateMortgageRateDto`), read `account.currentBalance` today, a
   through-today read model that is stale for a future-dated change. Fixed in P1-B3 for ANNUITY and
   CANADIAN_FIXED, before the new methods depend on it.
6. **Expand now, contract later** (`database/CLAUDE.md`): the column was
   nullable in Phases 1 and 2 and read through the legacy flags when null; it
   became `NOT NULL DEFAULT 'ANNUITY'` and the two flags were dropped in Phase 3
   (P3-B1), one release after Phase 1 shipped. A backup or an action-history
   snapshot written before then is resolved by the same rule on replay
   (section 4.2).
7. **Precision: the methods compute at storage precision, not at cents.** The
   constant principal is `roundMoney(P / N)` = 833.3333 in the worked example,
   not 833.33. This is the precision the annuity engine already uses (its
   300,000 / 2% / 360 installment is 1,108.8584 and its lifetime interest
   99,189.03, which is only reproduced at 4dp), and it is the only precision
   that reproduces every installment in the #1501 tables: at cents the
   2026-01-01 and 2027-01-01 installments would be 1,241.66 and 1,616.66
   against the tables' 1,241.67 and 1,616.67. Rejected: rounding the
   method's figures to the currency's minor unit, which would add a second
   money precision the codebase does not have. A ledger whose installments
   were recorded at statement cents (imported, or typed from the bank's
   statement) is priced from what it holds; section 7.2 asserts that case too.
8. **The final LINEAR SHORTEN_TERM installment absorbs a small leftover.**
   An installment is the final one, and its principal is the whole
   `debt(d)`, when `debt(d) - c <= roundMoney(N * 0.005)` (1.80 in the worked
   example). The bound is sized for rounding: `c` differs from `P / N`, so
   the ledger can reach the last scheduled principal with a little left over
   (0.0106 in the worked example; up to half a cent per payment when
   installments were recorded at statement cents), and half a cent per
   scheduled payment is the most a constant principal quoted at cents can
   leave over the whole term. The rule does not ask where a leftover came
   from: one of 1.80 or less left by a repayment that is not a multiple of
   `c` is absorbed the same way, which is the deliberate choice -- a separate
   payment of a few cents a period later serves nobody. A larger leftover is
   a real last payment, `min(c, debt(d))`. That is INV-LOAN-004's residual
   final payment for this method. The rule sits in the method's principal
   function on both layers, and the 7.1 fixture asserts that no leftover
   payment follows on 2050-07-01.
9. **Open point 1 (interest-only template shape): the managed template keeps
   its principal line, at zero.** Section 9 records the reasoning and the
   test obligations.
10. **`prepayment_mode` is null for every type but LINEAR**, enforced by a
    table CHECK (`prepayment_mode IS NULL OR mortgage_type = 'LINEAR'`), not
    by the form. The service writes null when the saved type is not LINEAR,
    whatever the request carries, because forms resend every field and a
    user switching from LINEAR to ANNUITY would otherwise be refused. A
    LINEAR row with a null mode reads as `SHORTEN_TERM`.
11. **`accounts.payment_amount` is null for LINEAR and INTEREST_ONLY.** Those
    methods have no constant payment, so the column has nothing true to hold:
    the installment for a date is table 4.3's answer at that date. Every
    surface that shows or uses "the payment" of such a mortgage asks for the
    installment of a dated occurrence instead. Section 5.6 has the rule, the
    mechanism and every consumer.

Open point 2 of #1501 (the "Record rate changes in Loan Details" hint shown for
every type when editing) is a copy decision owned by P1-F2, not by this spec.

## 4. Truth tables

### 4.1 Traits per type

One record per layer, `MORTGAGE_TYPE_TRAITS`, read through `compoundingFor`,
`amortizationMethodFor` and `annualizationFor`. A consumer is written against
a trait rather than a type literal, so adding a type is one row plus the
compiler's exhaustiveness errors (`Record<MortgageType, ...>`).

| Type | Compounding | Method | Annualization (rate inference) |
| --- | --- | --- | --- |
| `ANNUITY` | `NOMINAL`: `annualRate / 100 / ppy` | `ANNUITY` | `DAY_COUNT`: `periodicRate * 365 / days` |
| `CANADIAN_FIXED` | `SEMI_ANNUAL`: `(1 + annualRate / 200)^(2 / ppy) - 1` | `ANNUITY` | `SEMI_ANNUAL`: `((1 + periodicRate)^(ppy / 2) - 1) * 2` |
| `LINEAR` | `NOMINAL` | `LINEAR` | `DAY_COUNT` |
| `INTEREST_ONLY` | `NOMINAL` | `INTEREST_ONLY` | `DAY_COUNT` |

Asserted by: every row, `mortgage-type.util.spec.ts` ("MORTGAGE_TYPE_TRAITS",
one case per type) and the shared truth table `mortgage-type-cases.json`, read
on both layers by `mortgage-type.contract.spec.ts` and
`mortgage-type.contract.test.ts` (traits, periodic rate, first interest, first
principal per method and EAR per type); the frontend record alone by
`mortgage-type.test.ts`. The compounding formulas by
`mortgage-amortization.util.spec.ts` ("periodic-rate convention"); the
annualization column by `rate-change-inference.service.spec.ts`.

The effective annual rate follows the compounding trait exactly as
`calculateEffectiveAnnualRate` does today: `(1 + annualRate / 200)^2 - 1` for
`SEMI_ANNUAL`, `(1 + annualRate / 100 / ppy)^ppy - 1` for `NOMINAL`.

### 4.2 Legacy flags to type, and what changed

| `is_canadian_mortgage` | `is_variable_rate` | Pre-type periodic rate | Pre-type inference | Type | Rate change | Inference change |
| --- | --- | --- | --- | --- | --- | --- |
| false | false | nominal | day count | `ANNUITY` | none | none |
| false | true | nominal | day count | `ANNUITY` | none | none |
| true | false | semi-annual | semi-annual inversion | `CANADIAN_FIXED` | none | none |
| true | true | nominal | `periodicRate * ppy` | `ANNUITY` | none | day count |

A NULL flag reads as false. Asserted by: both migrations landing each row on
its type, a NULL flag included, and every non-mortgage row on `ANNUITY`, by
`mortgage-type-backfill.integration.spec.ts`; the same rule on a replayed
snapshot by `legacy-mortgage-type.util.spec.ts`,
`legacy-mortgage-type-restore.spec.ts`, `action-history.service.spec.ts` and
`backup-restore.integration.spec.ts` ("restores every mortgage of a backup
taken before the type was required with its type"); the last row's inference
change by `rate-change-inference.service.spec.ts` ("annualizes an ANNUITY
mortgage by day count").

The last row was the only behaviour change of Phase 1, and it touched detected
rate changes only: a Canadian variable-rate account's inferred rate moved from
`periodicRate * ppy` to the day-count annualization every other nominal
mortgage uses (`annualizeRate` in
`backend/src/loan-rate-changes/rate-change-inference.service.ts` and its mirror
in `frontend/src/lib/loan-history.ts`). The release note of P1-Q names it.

Since the contract migration the flags exist only in what was written before
it: a backup's `accounts` rows and an action-history account snapshot. The
backup restore and the undo resolve such a row through
`backend/src/accounts/legacy-mortgage-type.util.ts` before today's column
filter drops the flags: a stored type stands, a missing or null one on a
MORTGAGE is this table's type, and any other account takes `ANNUITY`.

### 4.3 `prepayment_mode`

| Type | Mode | Principal at `d` | After an extra repayment | After a rate change | Term end | Asserted by |
| --- | --- | --- | --- | --- | --- | --- |
| `ANNUITY`, `CANADIAN_FIXED` | null | installment - interest | installment unchanged, loan ends earlier | installment re-derived only by the user-confirmed sync | moves earlier with repayments | `scheduled-transaction-loan.service.spec.ts` (INV-LOAN-006's waterfall); `loan-rate-changes.service.spec.ts` (the sync); `mortgage-type.util.spec.ts` (no mode off LINEAR) |
| `LINEAR` | `SHORTEN_TERM` or null | `min(c, debt(d))`; the whole `debt(d)` on the final installment (decision 8) | `c` unchanged, loan ends earlier | principal unchanged, interest moves | moves earlier with repayments | `mortgage-installment.util.spec.ts` ("methodPrincipal", the leftover within and above the bound); `scheduled-transaction-loan.mortgage-methods.spec.ts` (table 7.1); `loan-schedule-methods.test.ts` (table 7.1, a null mode); `mortgage-type.util.spec.ts` (a null mode reads as SHORTEN_TERM) |
| `LINEAR` | `LOWER_INSTALLMENT` | `roundMoney(debt(d) / remaining(d))`; the whole `debt(d)` when `remaining(d) <= 1` | principal falls from the next due date | principal unchanged, interest moves | fixed at payment `N` | `mortgage-installment.util.spec.ts`; `scheduled-transaction-loan.mortgage-methods.spec.ts` (table 7.3, a due date moved off the calendar, payment `N`); `scheduled-loan-dated-balance.integration.spec.ts`; `loan-schedule-methods.test.ts` (table 7.3) |
| `INTEREST_ONLY` | null | 0; the whole `debt(d)` when `remaining(d) <= 1` (the bullet) | interest falls, bullet falls | interest moves | fixed at payment `N` | `mortgage-installment.util.spec.ts`; `scheduled-transaction-loan.mortgage-methods.spec.ts` (table 7.4, the bullet written before payment `N`); `loan-schedule-methods.test.ts` (table 7.4) |

Interest is `roundMoney(debt(d) * r(d))` in every row (INV-LOAN-006,
unchanged). A due date past the term end (`remaining(d) <= 0`, an overdue
schedule) prices the whole debt as principal under every non-annuity method:
the term has ended and nothing is left to spread it over. Asserted by
`mortgage-installment.util.spec.ts` ("past the term end the whole debt is
principal", each method and mode) and `loan-schedule-methods.test.ts` ("prices
the whole debt on a row past the term end").

## 5. Formulas per surface

### 5.1 Preview (`calculateMortgageAmortization`)

Branch on `amortizationMethodFor(type)` before `calculateMortgagePayment` and
`calculateResidualPayoff`, which stay the ANNUITY path.

| Field | LINEAR | INTEREST_ONLY |
| --- | --- | --- |
| `paymentAmount` | first installment, `c + roundMoney(P * r)` | `roundMoney(P * r)` |
| `principalPayment` | `c` | 0 |
| `interestPayment` | `roundMoney(P * r)` | `roundMoney(P * r)` |
| `totalPayments` | `N` | `N` |
| `totalInterest` | `roundMoney(P * r * (N + 1) / 2)` | `roundMoney(P * r * N)` |
| `residualPayoffAmount` | `roundMoney((P - (N - 1) * c) * (1 + r))` | `roundMoney(P * (1 + r))`, the bullet |
| `endDate` | payment `N` (INV-LOAN-005) | payment `N` |
| `effectiveAnnualRate` | per 4.1 | per 4.1 |

The preview has no events, so `r` is the account's scalar rate. An accelerated
frequency (`ACCELERATED_BIWEEKLY`, `ACCELERATED_WEEKLY`) is refused with a 400
for both methods: acceleration is defined as a fraction of the annuity's
monthly installment and has no meaning for either.

Asserted by: every field of both columns at table 7.5's figures, and the
accelerated refusal, by `mortgage-amortization.util.spec.ts`
("calculateMortgageAmortization: LINEAR and INTEREST_ONLY"); the refusal on
create before anything is written by
`loan-mortgage-account.mortgage-methods.spec.ts`; the same figures from the
frontend projection by `loan-schedule-methods.test.ts` ("preview with no
events"); the form's display by `MortgageFields.test.tsx`.

### 5.2 Installment pricing (`resolveInstallment`)

`ScheduledTransactionLoanService.resolveInstallment`
(`backend/src/scheduled-transactions/scheduled-transaction-loan.service.ts`)
stays the one pricing path. Interest is unchanged. Principal comes from table
4.3 instead of `payment - interest` when the method is not ANNUITY, and for
those methods the installment is derived: the template-mode amount is
principal + interest + extra, not bounded by `account.paymentAmount`.
`allocateLoanPayment` remains the waterfall, called with that derived payment,
so the debt clamp and the interest-first rule hold for every method.

**The collision with "a posting never grows the parent"**
(`docs/specs/scheduled-loan-installment-pricing.md` section 3; the mechanism is
`InstallmentPurpose`: a posting prices the template's own amount). After a rate
rise a LINEAR installment grows, and a posting re-divides the bill the user was
shown without growing it. Two mechanisms close the gap, and neither relaxes the
posting rule:

- the rate-change sync (`LoanRateChangesService.syncScheduledTransaction`,
  user-confirmed) rewrites the template at the effective date with the
  method's installment;
- template advancement (`recalculateLoanPaymentSplits`, `InstallmentPurpose`
  `"template"`) targets the method's installment for non-annuity methods,
  where for ANNUITY it grows back only toward `account.paymentAmount`.

So a declined sync leaves at most one occurrence posted at the old total,
re-divided interest-first; the advancement after it prices the next one at the
new installment. P2-B1 carries a test of exactly that sequence:
`scheduled-transaction-loan.mortgage-methods.spec.ts` ("re-divides a stale
template after a rate rise, and the next advancement heals it"), beside "grows
the template to the method installment, unbounded by payment_amount".

### 5.3 Rate change (`buildScheduledUpdate`, `recalculatePaymentForRate`, the mortgage rate update)

All three read `debt(effectiveDate)` (decision 5).

| Method | New installment at the effective date | Asserted by |
| --- | --- | --- |
| ANNUITY | the annuity payment of `debt(effectiveDate)` over the remaining amortization at the new rate (today's formula, dated debt) | `loan-rate-changes.service.spec.ts` ("prices a future-dated recalculation from the debt after a payment posted before it") |
| LINEAR, SHORTEN_TERM | `c + roundMoney(debt * r_new)` | `loan-rate-changes.mortgage-methods.spec.ts` ("a future-dated change on a linear mortgage changes the template's interest line only"); `loan-mortgage-account.mortgage-methods.spec.ts` ("answers the method's installment at the effective date") |
| LINEAR, LOWER_INSTALLMENT | `roundMoney(debt / remaining) + roundMoney(debt * r_new)` | `loan-rate-changes.mortgage-methods.spec.ts` ("re-derives a LOWER_INSTALLMENT principal from the remaining payments, not from the rate") |
| INTEREST_ONLY | `roundMoney(debt * r_new)` | `loan-rate-changes.mortgage-methods.spec.ts` ("prices an interest-only template at the new rate with a zero principal line"); `loan-mortgage-account.mortgage-methods.spec.ts` ("answers the interest alone") |

What a rate change writes:

| Method | Template (through the user-confirmed sync) | `accounts.payment_amount` | `loan_rate_changes.new_payment_amount` | Asserted by |
| --- | --- | --- | --- | --- |
| ANNUITY, CANADIAN_FIXED | the new installment, as today | unchanged from today's behaviour | as today: stated by the user, recalculated, or inferred | `loan-rate-changes.service.spec.ts`; `loan-rate-changes.mortgage-methods.spec.ts` ("still accepts a stated payment on an annuity mortgage") |
| LINEAR, INTEREST_ONLY | the new installment above, split per table 4.3 | stays null (decision 11) | null: the method states every installment, so a stated payment would be a second, conflicting answer. The mortgage rate update refuses a non-null `paymentAmount` for these methods with a 400 naming the method; rate inference writes null for them. | `loan-rate-changes.mortgage-methods.spec.ts` ("applies the confirmed sync with the method's split", "records no payment when asked to recalculate one", the stated-payment refusal); `loan-mortgage-account.mortgage-methods.spec.ts` ("refuses a stated payment for a LINEAR mortgage before recording anything"); `rate-change-inference.service.spec.ts` ("records no payment for a %s mortgage, cutting segments on the rate alone") |

A declined sync leaves the template at the old installment for one posting
(section 5.2); nothing else holds a copy that could go stale.

### 5.4 Frontend projection (`generateLoanSchedule`)

`frontend/src/lib/loan-schedule.ts` computes each row's principal by method
and mode exactly as table 4.3 does, with the row's own projected balance in
place of `debt(d)`. SHORTEN_TERM ends when the balance reaches zero;
LOWER_INSTALLMENT and INTEREST_ONLY need the term end, which
`buildLoanProjectionInput` (`frontend/src/lib/loan-history.ts`) supplies from
`payment_start_date` and `amortization_months`. Re-levelling and the stall
rescue stay annuity-only: a LINEAR or INTEREST_ONLY installment does not
stall, because table 4.3 sets its principal independently of the interest
rather than as the remainder of a fixed payment. Asserted by
`loan-schedule-methods.test.ts` (tables 7.1, 7.3, 7.4 and 7.5; "annuity-only
machinery does not apply") and `loan-history.mortgage-methods.test.ts`
(`buildLoanProjectionInput` supplying the method terms and the term end).

### 5.5 Setup payments

`LoanPaymentSetupService` routes every mortgage through the method-aware split
(the first installment is principal and interest from table 4.3 at
`payment_start_date`), and `amortization_months` is required for LINEAR and
INTEREST_ONLY (section 8). Asserted by `loan-payment-setup.mortgage-methods.spec.ts`
(the first installment priced from the ledger, a mismatched payment refused
before writing, the zero INTEREST_ONLY principal line, and
`previewFirstInstallment` answering what the setup accepts) and
`LoanPaymentSetupDialog.test.tsx`.

### 5.6 The stored payment (`accounts.payment_amount`)

For ANNUITY and CANADIAN_FIXED the column keeps its meaning: the contractual
installment, user-owned, as today. For LINEAR and INTEREST_ONLY it is null
(decision 11), for three reasons:

- **A snapshot goes stale on the first repayment.** Storing the first
  installment (the preview's `paymentAmount`, 1,333.3333 in 7.5) would leave
  that figure on the record while the bill falls to 1,241.6666 (7.1,
  2026-01-01), and every reader below would show or compute from it.
- **Rewriting it on every posting makes a read model nobody owns.** The column
  is user-owned (`docs/specs/scheduled-loan-installment-pricing.md` section 4:
  recording a rate change deliberately does not write it), and a
  method-written copy would be a second answer to "what is the installment" beside
  `resolveInstallment`'s.
- **Null fails loudly where a stale figure fails quietly.** A reader that was
  missed reads no payment -- on the frontend `resolveCurrentLoanTerms` then
  has no installment and the projection is withheld -- rather than a
  confident, wrong one. The table below lists every reader so none is left to
  that fallback.

Mechanism: a table CHECK added by P2-B1,
`payment_amount IS NULL OR mortgage_type IS NULL OR mortgage_type IN ('ANNUITY', 'CANADIAN_FIXED')`,
so a writer that was missed fails at the constraint instead of storing a
figure. A type change rewrites the column in the same transaction as the type:
to null when the new method is not ANNUITY, and to the annuity installment of
`debt(d)` over the remaining amortization at `rate(d)`, for `d` the next due
date (the 5.3 ANNUITY formula), when it is.

"The installment" of a non-annuity mortgage is a dated question, and has two
answers, both existing paths:

- **the next one**: the scheduled payment's next occurrence, priced by
  `resolveInstallment` (`ScheduledOccurrenceService` on the server,
  `nextOccurrenceEffectiveAmount` / `nextOccurrenceDueDate` on the client;
  INV-OCCURRENCE-003), or the loan anchor's due date and debt
  (`GET /scheduled-transactions/loan-anchor/:accountId`) priced by table 4.3;
- **a projected one**: the row of `generateLoanSchedule` for that date.

A surface that shows it says which date it is for. For INTEREST_ONLY every
surface that shows the installment also shows the bullet and its date, because
an interest-only installment without its bullet understates what is owed by
the whole principal.

Every reader of the stored payment, and what it does for LINEAR and
INTEREST_ONLY:

| Reader | Reads today | For LINEAR and INTEREST_ONLY | Task | Asserted by |
| --- | --- | --- | --- | --- |
| `LoanMortgageAccountService` create (`backend/src/accounts/loan-mortgage-account.service.ts`) | stores the preview's `paymentAmount`; the template is `-paymentAmount` | stores null; the template is the first installment from the preview | P2-B1 | `loan-mortgage-account.mortgage-methods.spec.ts` ("createMortgageAccount") |
| `LoanMortgageAccountService` mortgage rate update (`UpdateMortgageRateDto`) | `newPaymentAmount ?? account.paymentAmount`, `currentBalance` | 5.3; a stated payment refused | P1-B3 (dated debt), P2-B1 | `loan-mortgage-account.mortgage-methods.spec.ts` ("updateMortgageRate") |
| `LoanPaymentSetupService` (`SetupLoanPaymentsDto.paymentAmount`) | the request's payment, written to the column and the template | the server prices the first installment from table 4.3; a request whose `paymentAmount` differs from it by more than 0.00005 is refused (the dialog previews through the same code), and the column is not written | P2-B1 | `loan-payment-setup.mortgage-methods.spec.ts` |
| `ScheduledTransactionLoanService.resolveInstallment` | `Math.max(templateAmount, account.paymentAmount)` for purpose `"template"` | the method installment (5.2); the column is not read | P2-B1 | `scheduled-transaction-loan.mortgage-methods.spec.ts` |
| `ScheduledTransactionsService` schedule update (`backend/src/scheduled-transactions/scheduled-transactions.service.ts`) | a template amount edit writes `payment_amount` | not written; the edit stands for the template only, and the next advancement reprices it (5.2) | P2-B1 | `scheduled-transactions.service.spec.ts` ("records no payment amount when the user edits a %s mortgage's schedule") |
| `LoanRateChangesService` (`buildScheduledUpdate`, `recalculatePaymentForRate`) | `override?.paymentAmount ?? account.paymentAmount` | 5.3 | P1-B3, P2-B1 | `loan-rate-changes.mortgage-methods.spec.ts` |
| `RateChangeInferenceService` | a segment's most common payment becomes `new_payment_amount` | null (5.3); segments are still cut on the rate alone | P2-B1 | `rate-change-inference.service.spec.ts` |
| `LlmAccountRow.paymentAmount` (`getLlmAccounts`, the MCP accounts tool, the in-app assistant) | the column | null, beside `mortgageType` (P1-B3) and the next occurrence's amount and date; INTEREST_ONLY also carries the bullet and its date | P2-B1 | `accounts.service.spec.ts` ("carries a dated installment for LINEAR and INTEREST_ONLY, and the bullet"); `mortgage-installment-facts.spec.ts` |
| `LoanPaymentDetectorService` | a detected payment offered for setup | a suggestion for the template; not written to the column (the CHECK refuses it) | P2-B2 | `loan-payment-setup.mortgage-methods.spec.ts` (the setup stores no payment); `mortgage-method-checks.integration.spec.ts` (the CHECK refuses one) |
| MNY import (`backend/src/import/mny/map/map-loans.ts`, `backend/src/import/mny/writers/write-loans.ts`) | writes the imported payment | imported mortgages carry the account's type (the default ANNUITY on an account the import creates); a re-import into a profile where the user switched one to LINEAR or INTEREST_ONLY leaves its payment null | P2-B1 | `write-loans.spec.ts` ("leaves a %s mortgage's payment null on a re-import") |
| `resolveCurrentLoanTerms` (`frontend/src/lib/loan-history.ts`) | a stated rate-change payment, the observed installment, then `account.paymentAmount` | none of the three; the current installment is the next occurrence's | P2-F1 | `loan-history.mortgage-methods.test.ts` ("resolveCurrentLoanTerms") |
| `generateLoanSchedule` (`frontend/src/lib/loan-schedule.ts`) | `paymentAmount`, then a stated payment per rate change | per-row principal from table 4.3; stated payments not read (5.4) | P2-F1 | `loan-schedule-methods.test.ts` |
| `LoanSummaryCards` (`frontend/src/components/accounts/loan-detail/LoanSummaryCards.tsx`) | `currentInstallment` from `resolveCurrentLoanTerms` | the next installment, captioned with its due date; INTEREST_ONLY adds the bullet and its date | P2-F1 | `LoanSummaryCards.test.tsx` |
| `loanNotAmortizingReason` (`frontend/src/lib/loan-figures.ts`) | payment against one period's interest | does not apply (5.4: these methods do not stall); returns null | P2-F1 | `loan-figures.test.ts` ("does not apply to a %s mortgage") |
| `OverpaymentSimulator` (`frontend/src/components/accounts/loan-detail/OverpaymentSimulator.tsx`) | `budget < paymentAmount`; "keep paying X" | an extra amount is added to each projected installment; a budget is a fixed total per period, the extra in each row is `budget - installment` of that row, and a budget below the first projected installment is refused with that installment named | P2-F1 | `OverpaymentSimulator.test.tsx`; `loan-schedule-methods.test.ts` ("the simulator modes on a LINEAR loan") |
| `loan-overpayment-solver` (`frontend/src/lib/loan-overpayment-solver.ts`) | `paymentAmount * 2` as the search bound | the first projected installment in its place | P2-F1 | `loan-history.mortgage-methods.test.ts` ("the goal-seek on a LINEAR mortgage") |
| `loan-past-impact` (`frontend/src/lib/loan-past-impact.ts`) | the contractual annuity payment from the original principal | the contractual schedule is the method's schedule from `P` at `payment_start_date`; extra principal is what was paid above its principal | P2-F1 | `loan-history.mortgage-methods.test.ts` ("computePastImpact") |
| `LoanAmortizationReport` (`frontend/src/components/reports/LoanAmortizationReport.tsx`) | shows a payment amount | shows the next installment with its date; INTEREST_ONLY adds the bullet | P2-F1 | `LoanAmortizationReport.test.tsx` |
| `MortgageFields`, `LoanPaymentSetupDialog` | the preview's `paymentAmount`; an editable payment | captioned "first installment"; read-only for these methods | P2-F1 | `MortgageFields.test.tsx`; `LoanPaymentSetupDialog.test.tsx` |

## 6. Invariants

### 6.1 INV-LOAN-007 (new): one amortization method per mortgage type

A mortgage's amortization method is a function of its type alone, and every
surface that prices, projects or infers -- the creation preview, the persisted
payment, the scheduled installment (template and posting), the rate-change
recalculation, the frontend projection and rate inference -- reads it through
the type's traits, not from a surface-local rule.

Mechanism, built by the tasks named:

- `MORTGAGE_TYPE_TRAITS` (`backend/src/accounts/mortgage-type.util.ts`, P1-B2;
  `frontend/src/lib/mortgage-type.ts`, P1-F1), a `Record` over the type, so a
  missing type is a compile error;
- the method branch in `calculateMortgageAmortization`, `resolveInstallment`,
  the rate-change paths and `generateLoanSchedule` (P2-B1, P2-F1);
- the parity fixture `backend/src/accounts/mortgage-type-cases.json` read by a
  backend spec and `frontend/src/lib/mortgage-type.contract.test.ts`, because
  the layers are separate packages that do not import each other (the `loan-rate-timeline-cases.json`
  pattern);
- the CHECK constraint on `accounts.mortgage_type`, reconciled with
  `MORTGAGE_TYPES` by a contract spec, on a column that is `NOT NULL` since
  P3-B1;
- the CHECK keeping `accounts.payment_amount` null for LINEAR and
  INTEREST_ONLY (decision 11, section 5.6), so no stored constant payment can
  disagree with the method.

Status: `enforced` in `docs/system-invariants.md` from P2-Q. It was registered
`unenforced` at S1 and was `partial` from P1-Q, while the traits, the parity
fixture and the CHECK contract spec existed but the method branch did not. The tests that hold it are the "Asserted by" entries of
sections 4, 5 and 7 to 10.

### 6.2 INV-LOAN-006 (extended): the remaining count is dated too

The installment now prices three things through its own due date: the debt,
the rate, and, for LOWER_INSTALLMENT and INTEREST_ONLY, `remaining(d)`. The
count comes from the calendar (`k(d)` from `payment_start_date` through
`calculateNextDueDate`), not from a count of postings, so a skipped
occurrence or an extra manual payment does not move the term end. The
INV-LOAN-006 entry's Statement says so from P2-Q.

### 6.3 INV-LOAN-003 (mechanism moves): one compounding convention, named

The convention does not change. Its mechanism moved from a two-flag test in
`getPeriodicRate` and `calculateEffectiveAnnualRate` to `compoundingFor(type)`;
the two-flag overloads delegated to the type-keyed functions during Phases 1
and 2 (P1-B2) and were deleted in Phase 3 (P3-B1). P1-Q updates the entry and `docs/financial-semantics.md` section 9.
The wrong "uses monthly compounding" copy goes with the task that owns each
file: the schema comment in P1-B1, `create-account.dto.ts` and
`mortgage-preview.dto.ts` in P1-B3, `mortgageFields.variableRateDesc` in
P1-F2.

### 6.4 INV-LOAN-004 (extended): the bullet is the residual

The final payment is the residual payoff for every method: the annuity's
(unchanged), the LINEAR final installment that absorbs a small leftover
(decision 8), and the INTEREST_ONLY bullet, `debt + roundMoney(debt * r)` at
payment `N`. A lifetime-interest total is the sum of what the schedule charges
(the closed forms of 5.1, checked against the row sums of section 7), not
`paymentAmount * N - P` for any method. The INV-LOAN-004 entry says so from
P2-Q.

### 6.5 INV-LOAN-005 (unchanged)

`payment_start_date` is payment 1 for every method; `N` payments end at
payment `N`, `N - 1` intervals after it.

## 7. Worked example (the fixtures)

EUR 300,000, 30 years (`amortization_months` 360), monthly, first payment
2024-01-01, 2.00% from 2024-01-01, 4.00% from 2027-01-01 (a
`loan_rate_changes` row), repayments of 20,000 on 2025-07-01 and 15,000 on
2026-01-01. A repayment dated on a due date is in `debt(d)` for that
installment (INV-LOAN-006: "on or before"). `N` = 360, `c` = 833.3333, the
residue bound of decision 8 is 1.80.

Each table gives the debt two ways: **exact** (the schedule with unrounded
principal, which is what #1501 printed) and **as posted** (the ledger after
the engine's own 4dp postings, which is what `datedLoanDebt` returns and what
the fixtures assert). Principal, interest and installment are the engine's 4dp
figures; the fixtures assert those, and printed at cents they are #1501's.

### 7.1 LINEAR, SHORTEN_TERM (default)

| Due | Event | Rate | Debt exact | Debt as posted | Principal | Interest | Installment |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2024-01-01 | first payment | 2.00% | 300,000.00 | 300,000.0000 | 833.3333 | 500.0000 | 1,333.3333 |
| 2024-02-01 | | 2.00% | 299,166.67 | 299,166.6667 | 833.3333 | 498.6111 | 1,331.9444 |
| 2025-07-01 | repayment 20,000 | 2.00% | 265,000.00 | 265,000.0006 | 833.3333 | 441.6667 | 1,275.0000 |
| 2026-01-01 | repayment 15,000 | 2.00% | 245,000.00 | 245,000.0008 | 833.3333 | 408.3333 | 1,241.6666 |
| 2026-12-01 | | 2.00% | 235,833.33 | 235,833.3345 | 833.3333 | 393.0556 | 1,226.3889 |
| 2027-01-01 | rate change | 4.00% | 235,000.00 | 235,000.0012 | 833.3333 | 783.3333 | 1,616.6666 |
| 2050-06-01 | final, absorbs 0.0106 | 4.00% | 833.33 | 833.3439 | 833.3439 | 2.7778 | 836.1217 |

Last payment 2050-06-01: 318 payments, 42 fewer than scheduled. Lifetime
interest 127,066.6723 (127,066.67), the sum of the interest column over all
318 rows. Without decision 8 the schedule would post a 319th payment of 0.0106
on 2050-07-01; the fixture asserts it does not.

Asserted by: `mortgage-installment.util.spec.ts` ("7.1 LINEAR, SHORTEN_TERM",
row by row); `scheduled-transaction-loan.mortgage-methods.spec.ts` ("LINEAR,
SHORTEN_TERM (spec table 7.1)", including the final installment and the absent
2050-07-01 payment); `loan-schedule-methods.test.ts` ("generateLoanSchedule:
LINEAR, SHORTEN_TERM (spec table 7.1)", the rows, the debt as posted, 318
payments and the lifetime interest); `loan-history.mortgage-methods.test.ts`
(row 1 as the anchor's bill, and the projection to 2050-06-01).

### 7.2 The same ledger, installments recorded at statement cents

The bank's statement shows 833.33 per month, and a user who imports it (or
types it) has a ledger of cents. The pricing reads what the ledger holds:

| Due | Debt as posted | Principal | Interest | Installment |
| --- | --- | --- | --- | --- |
| 2025-07-01 | 265,000.06 (eighteen installments of 833.33, then the 20,000 repayment) | 833.3333 | 441.6668 | 1,275.0001 |

At cents the figures are the same as 7.1's (833.33, 441.67, 1,275.00). The
eighteen postings of 833.33 leave 0.06 more debt than the exact schedule
(18 x 0.00333...). Had all 318 installments been recorded at cents, the
residue at the end would be 1.06, inside decision 8's bound of 1.80, so the
final installment still absorbs it.

Asserted by: `mortgage-installment.util.spec.ts` ("7.2 the same ledger recorded
at statement cents") and `scheduled-transaction-loan.mortgage-methods.spec.ts`
("prices a ledger recorded at statement cents from what it holds (table 7.2)").

### 7.3 LINEAR, LOWER_INSTALLMENT

| Due | Event | Rate | Debt as posted | Remaining | Principal | Interest | Installment |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 2024-01-01 | first payment | 2.00% | 300,000.0000 | 360 | 833.3333 | 500.0000 | 1,333.3333 |
| 2025-07-01 | repayment 20,000 | 2.00% | 265,000.0006 | 342 | 774.8538 | 441.6667 | 1,216.5205 |
| 2026-01-01 | repayment 15,000 | 2.00% | 245,350.8778 | 336 | 730.2109 | 408.9181 | 1,139.1290 |
| 2027-01-01 | rate change | 4.00% | 236,588.3470 | 324 | 730.2109 | 788.6278 | 1,518.8387 |
| 2053-12-01 | final | 4.00% | 730.2109 | 1 | 730.2109 | 2.4340 | 732.6449 |

Last payment 2053-12-01 (payment 360, the term end is fixed). Lifetime
interest 144,396.8448 (144,396.84).

Asserted by: `mortgage-installment.util.spec.ts` ("7.3 LINEAR,
LOWER_INSTALLMENT"); `scheduled-transaction-loan.mortgage-methods.spec.ts`
("LINEAR, LOWER_INSTALLMENT (spec table 7.3)");
`scheduled-loan-dated-balance.integration.spec.ts` (the dated debt and
`remaining(d)` on a real ledger); `loan-schedule-methods.test.ts`
("generateLoanSchedule: LINEAR, LOWER_INSTALLMENT (spec table 7.3)");
`loan-history.mortgage-methods.test.ts` (over the payments left).

### 7.4 INTEREST_ONLY, same events

| Due | Event | Rate | Debt as posted | Principal | Interest | Installment |
| --- | --- | --- | --- | --- | --- | --- |
| 2024-01-01 | first payment | 2.00% | 300,000.0000 | 0 | 500.0000 | 500.0000 |
| 2025-07-01 | repayment 20,000 | 2.00% | 280,000.0000 | 0 | 466.6667 | 466.6667 |
| 2026-01-01 | repayment 15,000 | 2.00% | 265,000.0000 | 0 | 441.6667 | 441.6667 |
| 2027-01-01 | rate change | 4.00% | 265,000.0000 | 0 | 883.3333 | 883.3333 |
| 2053-12-01 | bullet | 4.00% | 265,000.0000 | 265,000.0000 | 883.3333 | 265,883.3333 |

Asserted by: `mortgage-installment.util.spec.ts` ("7.4 INTEREST_ONLY");
`scheduled-transaction-loan.mortgage-methods.spec.ts` ("INTEREST_ONLY (spec
table 7.4 and section 9)"); `loan-schedule-methods.test.ts`
("generateLoanSchedule: INTEREST_ONLY (spec table 7.4)", the bullet on payment
`N`); `loan-history.mortgage-methods.test.ts` (the projection to the bullet).

### 7.5 Preview, no events (2.00% throughout)

| Method | `paymentAmount` | `principalPayment` | `interestPayment` | `totalPayments` | `totalInterest` | `residualPayoffAmount` | `endDate` |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ANNUITY (reference, today's engine) | 1,108.8584 | 608.8584 | 500.0000 | 360 | 99,189.03 | 1,108.8673 | 2053-12-01 |
| LINEAR | 1,333.3333 | 833.3333 | 500.0000 | 360 | 90,250.00 | 834.7342 | 2053-12-01 |
| INTEREST_ONLY | 500.0000 | 0 | 500.0000 | 360 | 180,000.00 | 300,500.0000 | 2053-12-01 |

The LINEAR closed form `P * r * (N + 1) / 2` = 90,250.00; the row-by-row sum
of 4dp interest is 90,250.0036, so a fixture comparing the two compares at
cents. The final LINEAR row's principal is 833.3453, which is `c` plus the
0.0120 residue decision 8 absorbs.

Asserted by: `mortgage-amortization.util.spec.ts` ("calculateMortgageAmortization:
LINEAR and INTEREST_ONLY (spec 5.1, table 7.5)", every column of every row);
`loan-schedule-methods.test.ts` ("preview with no events (spec table 7.5)", the
row sums at cents); the first payment of each row by `mortgage-type-cases.json`
on both layers.

### 7.6 How the figures were produced

Independently of the implementation, as INV-LOAN-004's fixtures are: a
period-by-period loop over the due dates with `roundMoney` on each principal
and interest, the repayment subtracted before pricing a due date it falls on,
and the rate switched on the effective date. A fixture copied from the
implementation's own output proves nothing about it; P2-B1 and P2-F1 copy these
tables, not their own results.

## 8. Missing-data policy

| Missing | Type | Answer | Asserted by |
| --- | --- | --- | --- |
| `amortization_months` | LINEAR, INTEREST_ONLY | Refused. Create and update answer 400 with a `tr(...)` message naming the field; the preview answers 400; `resolveInstallment` declines (persisted amounts post, as for any unmanaged shape) and the projection is withheld with a reason naming the field. There is no `N` to divide by and no term end for the bullet. | `mortgage-installment.util.spec.ts` ("missing terms (spec section 8)"); `mortgage-amortization.util.spec.ts` (the preview's 400); `accounts.service.spec.ts` (create and update refuse, writing nothing); `mortgage-method-columns.util.spec.ts`; `scheduled-transaction-loan.mortgage-methods.spec.ts` ("missing terms (spec section 8)": declines, the persisted amounts post); `loan-rate-changes.mortgage-methods.spec.ts` (no sync); `loan-schedule-methods.test.ts` and `loan-history.mortgage-methods.test.ts` (the projection withheld, naming the field) |
| `amortization_months` | ANNUITY, CANADIAN_FIXED | As today. | `mortgage-installment.util.spec.ts` ("names nothing for an annuity type") |
| `payment_start_date` | LINEAR, INTEREST_ONLY | Refused and declined exactly as a missing `amortization_months`: `k(d)` has no calendar to count, so there is no `remaining(d)` for LOWER_INSTALLMENT and no term end for the bullet. SHORTEN_TERM needs neither for its principal (`min(c, debt(d))`), but is refused on create and preview too, so the one rule covers the type. | `mortgage-installment.util.spec.ts` ("names every missing term of a non-annuity type", "has no calendar without a start date"); `scheduled-transaction-loan.mortgage-methods.spec.ts` (declines without `paymentStartDate`); `loan-history.mortgage-methods.test.ts` |
| `payment_frequency` | LINEAR, INTEREST_ONLY | Refused and declined as above: there is no `ppy`, so no `N`, no `c` and no periodic rate. `periodsPerYearForStoredFrequency` answers null for an unknown cadence, and that null is the refusal, never a default of 12. | `mortgage-installment.util.spec.ts` ("has no N without the amortization or a known cadence"); `scheduled-transaction-loan.mortgage-methods.spec.ts` (declines without `paymentFrequency`); `loan-schedule-methods.test.ts` |
| `payment_start_date`, `payment_frequency` | ANNUITY, CANADIAN_FIXED | As today. | `mortgage-installment.util.spec.ts` ("names nothing for an annuity type") |
| `original_principal` | LINEAR, SHORTEN_TERM | `abs(opening_balance)`, the amount borrowed when the account was opened. Stated here because it is a substitution, not a guess: a mortgage account's opening balance is the advance. | `mortgage-installment.util.spec.ts` ("falls back to the opening balance when original_principal is null"); `scheduled-transaction-loan.mortgage-methods.spec.ts` ("reads a mortgage whose original_principal is null from its opening balance"); `loan-schedule-methods.test.ts` ("reads abs(opening balance) when the original principal is unset") |
| `original_principal` and `opening_balance` 0 | LINEAR, SHORTEN_TERM | Refused as above: `c` would be 0 and the loan would not amortize. | `mortgage-installment.util.spec.ts` ("needs a principal only for SHORTEN_TERM"); `mortgage-amortization.util.spec.ts` ("LINEAR refuses a zero principal: c would be 0"); `loan-schedule-methods.test.ts` (c unknown, not 0) |
| `prepayment_mode` | LINEAR | `SHORTEN_TERM` (decision 10). | `mortgage-type.util.spec.ts` ("reads a null mode as SHORTEN_TERM"); `mortgage-type.test.ts` ("prepaymentModeOf") |
| `mortgage_type` | any | Cannot be missing: the column is `NOT NULL DEFAULT 'ANNUITY'` since P3-B1, and a snapshot written before it is resolved on replay by table 4.2. | `mortgage-type-backfill.integration.spec.ts` ("leaves the column NOT NULL DEFAULT 'ANNUITY' under the CHECK"); `legacy-mortgage-type.util.spec.ts` |
| a rate for `d` | any | As today: `effectiveAnnualRateOn` falls back to `accounts.interest_rate`. | `loan-rate-timeline-cases.json` on both layers (INV-LOAN-006); `loan-rate-changes.mortgage-methods.spec.ts` (no linear template priced at a defaulted 0%) |
| `debt(d)` unreadable | any | As today: the posting rolls back and the anchor endpoint errors (`docs/specs/scheduled-loan-installment-pricing.md` section 3). | `scheduled-transaction-loan.service.spec.ts` ("refuses rather than posting a stale split when the ledger cannot be read"); `loan-payment-setup.mortgage-methods.spec.ts` ("refuses when the ledger cannot be read, writing nothing") |

A zero debt is a known zero for every method: `paid-off`, as today. The
refusals above are what keep a null `P` from being read as 0 and a null `N`
from defaulting to 360.

## 9. Open point 1: the INTEREST_ONLY template shape

**Decision: the managed shape is unchanged, and an INTEREST_ONLY template
carries its principal transfer line at amount 0.**

What was checked:

- `validateSplitAmountSum` (`backend/src/common/split-amount.util.ts`), the
  validator both the transaction and the scheduled-transaction paths call,
  requires two or more lines and a signed sum equal to the parent. It does not
  refuse a zero line, so a 0 principal plus a 500 interest line under a 500
  parent passes.
- A zero transfer needs no rate and moves nothing on either side (the
  `amount === 0` branches in
  `backend/src/transactions/transaction-transfer.service.ts`).
- The waterfall (`allocateLoanPayment`) already produces principal 0 whenever
  the interest exceeds the base payment, so a zero principal line is a state
  the posting path reaches today.
- The principal transfer line is what identifies the template as the loan's
  (`findLoanAccountFromSplits`, `resolveInstallment`'s `principalSplit`), it is
  where the bullet lands at payment `N`, and it is what a later type change to
  LINEAR or ANNUITY fills in.

Rejected: an interest-only managed shape without a principal line. A
single-line template fails the validator's two-line minimum unless the line is
a transfer, so it would have to be a non-split template, which
`resolveInstallment` does not read and which loses the loan linkage the
fallback lookup depends on; and the bullet would need a line created mid-life,
which the recalculation does not do (it rewrites only split rows that
already exist).

The cost, accepted: each interest-only occurrence writes a 0.00 transfer row
into the loan's register. Collapsing zero lines at posting time would change
the posting path for every loan, and is a separate proposal if it is wanted.

Test obligations (P2-B1): a template with a 0 principal line passes
`validateSplits` on create, update and post; `resolveInstallment` treats it as
managed; a posted occurrence moves the loan balance by 0 and books the
interest; the advancement before payment `N` writes the bullet into the
principal line and grows the parent to debt + interest.

## 10. Type detection (P2-B2, P2-F2)

A suggestion: the detection endpoints return a type and persist nothing, and
the user confirms the type in the form or in Loan Details. From two or three consecutive installments (principal, interest) and
the quoted rate:

| Observation | Suggested type | Asserted by |
| --- | --- | --- |
| Principal 0 on every sample | `INTEREST_ONLY` | `mortgage-type-detection-cases.json`: "interest only, worked example terms" |
| Principal constant (within a cent), installment falling | `LINEAR` (mode not inferable from samples without a repayment between them) | `mortgage-type-detection-cases.json`: the linear worked-example cases |
| Installment constant, interest matches `SEMI_ANNUAL` compounding of the quoted rate and not `NOMINAL` | `CANADIAN_FIXED` | `mortgage-type-detection-cases.json`: "Canadian fixed at 6%", the demo seed's Scotiabank terms |
| Installment constant otherwise | `ANNUITY` | `mortgage-type-detection-cases.json`: the annuity cases |
| Fewer than two samples, or none of the above | no suggestion, with the reason | `mortgage-type-detection-cases.json`: "one sample", "no samples", "neither principal nor installment constant" |

The tolerances and the ledger-history variant are fixed by P2-B2's fixtures,
which add rows to this table rather than living only in the code.

P2-B2 implements it as `detectMortgageType`
(`backend/src/accounts/mortgage-type-detection.util.ts`), with the truth table
in `backend/src/accounts/mortgage-type-detection-cases.json`. Samples are
consecutive installments, oldest first, each with its principal, its interest
and, when known, the debt it was charged on. The tolerance is one cent per
sample: principals or installments are constant when each is within a cent of
the first, and an interest matches a convention when it is within a cent of
the debt times that convention's `getPeriodicRate`. The rows the fixtures add:

| Observation | Suggested type | Confidence | Asserted by |
| --- | --- | --- | --- |
| Principal 0 on every sample, interest at the quoted rate or unchecked | `INTEREST_ONLY` | high | "interest only, worked example terms", "interest only without balances" |
| Principal 0 on every sample, interest not at the quoted rate | `INTEREST_ONLY` | low | "interest only whose interest is not the quoted rate's" |
| Principal constant, installment falling, interest at the quoted rate or unchecked (both prepayment modes, either side of a repayment) | `LINEAR` | high | the linear worked-example cases, both modes across the 20,000 repayment, "linear without balances" |
| Principal constant, installment falling, interest not at the quoted rate | `LINEAR` | low | "linear whose interest is not the quoted rate's" |
| Principal constant, installment rising (a rate rise between the samples) | none | -- | "linear across the 2027-01-01 rate rise" |
| Principal and installment both constant (0%, or interest too small to move a cent) | none: both `LINEAR` and `ANNUITY` fit | -- | "ambiguous pair at 0%" |
| A `LINEAR` or `INTEREST_ONLY` shape at an accelerated frequency, which those methods refuse | none | -- | "linear shape at an accelerated frequency" |
| Installment constant, interest matches `SEMI_ANNUAL` and not `NOMINAL` (at 6% monthly, 0.4939% against 0.5000%) | `CANADIAN_FIXED` | high | "Canadian fixed at 6%", "Canadian fixed, the demo seed's Scotiabank terms" |
| Installment constant, interest matches `NOMINAL` and not `SEMI_ANNUAL` | `ANNUITY` | high | "annuity at 6%", "annuity at an accelerated frequency" |
| Installment constant, no balance, no rate or no mortgage frequency to check against | `ANNUITY` | low | "annuity without balances", "annuity without a quoted rate"; `mortgage-type-detection.util.spec.ts` ("cannot check the compounding without a frequency") |
| Installment constant, interest matches both conventions within a cent (a small debt) or neither (day-count interest) | `ANNUITY` | low | "annuity on a debt too small", "annuity whose interest is charged by day count" |
| Installment constant, principal falling (a rate rise between the samples) | none | -- | "level installment with a falling principal" |
| No principal and no interest; a negative or non-numeric figure | none | -- | "nothing paid on either sample"; `mortgage-type-detection.util.spec.ts` ("refuses %s as an invalid sample") |

A quoted name in either table is a case of `mortgage-type-detection-cases.json`,
which `mortgage-type-detection.util.spec.ts` runs case by case and checks for a
reason on every refusal.

Every answer carries a reason code (`MORTGAGE_TYPE_DETECTION_REASONS`), the
refusals included, so the client can say what was missing in the reader's
language. Two routes answer it, neither of which writes a row:
`POST /accounts/mortgage-type/detect` reads the samples from the request, and
`POST /accounts/:id/mortgage-type/detect` builds them from the mortgage's own
posted installments through the pairing rate-change inference reads
(`LoanPaymentDetectorService.buildInstallmentHistory`), each with the ledger
balance before its date. It reads only the rows `current_balance` sums
(`ledgerMovementPredicate`, dated on or before today), so a voided or
future-dated installment is neither a sample nor a shift in every balance
before it. The samples are the trailing run of consecutive installments at
the rate in effect on the latest one (`effectiveAnnualRateOn`), at most three,
so a rate change inside the window is not read as a method and an earlier
period at the same rate is not joined to the current one. A payment without an interest figure (a lump-sum
repayment, a transfer without a split) is left out. An interest-only
occurrence is read: the pairing keeps a 0.00 transfer leg into the loan when
its linked parent carries the interest (section 9), and drops one that does
not, which paid nothing. The pairing is shared, so rate-change inference and
payment detection read interest-only installments the same way.

The demo seed's Scotiabank mortgage posts its installments in the shape a
scheduled split payment does (a chequing split whose principal is a transfer
leg into the mortgage and whose interest is a `Housing > Mortgage Interest`
leg, the mortgage's interest category), its interest charged on the ledger
debt before each payment at the `CANADIAN_FIXED` periodic rate, so the
history route reads it back as `CANADIAN_FIXED` with high confidence.

The routes are asserted by `loan-mortgage-account.mortgage-type-detection.spec.ts`
(the history read: interest-only 0.00 legs, voided and future-dated
installments left out, one rate period only, the refusal with its reason) and
`accounts.controller.spec.ts`; the pairing by `loan-payment-detector.service.spec.ts`
("buildPaymentRecords: interest-only installments"). The client (P2-F2) shows
the suggestion and changes nothing until the user accepts it:
`MortgageTypeDetector.test.tsx` (the create form's select set only on "Use This
Type", an answer dropped once its inputs change, a failed request said to be
one), `MortgageTypeHistoryDetector.test.tsx` (the suggestion with the
installments it was read from) and `MortgageFields.test.tsx` ("type
detection"); `mortgage-type-detection.contract.test.ts` holds
`MORTGAGE_TYPE_DETECTION_REASONS` to the backend's list and to the English
catalog.

## 11. Test matrix

The suite column names the files that assert each row. Every row is met except
the E2E one, which has no spec to hold it and says why.

| Layer | Suite | What it asserts | Task |
| --- | --- | --- | --- |
| Database | `mortgage-type-backfill.integration.spec.ts`, `scripts/verify-schema.sh` | both migrations per table 4.2; NOT NULL and the default; CHECK refuses an unknown type; `schema.sql` and the migrations agree, the flags gone | P1-B1, P3-B1 |
| Backup and undo | `legacy-mortgage-type.util.spec.ts`, `legacy-mortgage-type-restore.spec.ts`, `action-history.service.spec.ts`, `backup-restore.integration.spec.ts` | a pre-contract snapshot replays with its table 4.2 type | P3-B1 |
| Backend unit | `mortgage-type.util.spec.ts` | traits per 4.1; prepayment mode per decisions 4 and 10 | P1-B2, P2-B1 |
| Backend unit | `mortgage-amortization.util.spec.ts` ("periodic-rate convention") | rate and EAR per type follow its compounding trait | P1-B2 |
| Backend contract | `mortgage-type.contract.spec.ts` (reads `database/schema.sql`) | the `mortgage_type` and `prepayment_mode` CHECK lists equal `MORTGAGE_TYPES` and `PREPAYMENT_MODES`, both directions | P1-B2, P2-B1 |
| Parity | `mortgage-type-cases.json`, read by `mortgage-type.contract.spec.ts` and `mortgage-type.contract.test.ts` | traits, rate, first installment and EAR per type agree | P1-B2, P1-F1 |
| Backend unit | `loan-rate-changes.service.spec.ts` | the rate-change paths read `debt(effectiveDate)`, not `currentBalance`, with a future-dated change | P1-B3 |
| Backend unit | `mortgage-amortization.util.spec.ts` ("calculateMortgageAmortization: LINEAR and INTEREST_ONLY") | table 7.5; accelerated frequencies refused for both new methods | P2-B1 |
| Backend unit | `mortgage-installment.util.spec.ts` | the calendar of section 2; table 4.3 and decision 8; tables 7.1 to 7.4 row by row; the refusals of section 8 | P2-B1 |
| Backend unit | `scheduled-transaction-loan.mortgage-methods.spec.ts` | tables 7.1 to 7.4 through `resolveInstallment`, including the 7.2 cents ledger and the absent 2050-07-01 payment; section 9's obligations; the stale-template-after-rate-rise sequence (5.2); a method change repricing the template (5.6) | P2-B1 |
| Backend unit | `split-amount.util.spec.ts` | an INTEREST_ONLY template's zero principal line passes the split validator (section 9) | P2-B1 |
| Backend unit | `rate-change-inference.service.spec.ts` | the 4.2 row 4 annualization change; LINEAR and INTEREST_ONLY record no payment and annualize by day count | P1-B3, P2-B1 |
| Backend integration | `scheduled-loan-dated-balance.integration.spec.ts` | `remaining(d)` and the dated debt on a real ledger for a LOWER_INSTALLMENT account, including a next due date moved off the calendar (`k(d)` per section 2) | P2-B1 |
| Backend integration | `mortgage-method-checks.integration.spec.ts` | the `payment_amount` and `prepayment_mode` CHECKs refuse a non-null value on a type they do not apply to; a type change that clears the payment is taken (5.6) | P2-B1 |
| Backend unit | `loan-mortgage-account.mortgage-methods.spec.ts`, `loan-payment-setup.mortgage-methods.spec.ts`, `loan-rate-changes.mortgage-methods.spec.ts`, `mortgage-method-columns.util.spec.ts`, `mortgage-installment-facts.spec.ts`, `accounts.service.spec.ts`, `scheduled-transactions.service.spec.ts`, `write-loans.spec.ts` | the backend rows of table 5.6: null stored, stated payments refused, inference writes null, the LLM row carries the next occurrence (and the bullet for INTEREST_ONLY); the missing-data refusals of section 8 | P2-B1 |
| Frontend unit | `loan-history.mortgage-methods.test.ts`, `loan-figures.test.ts`, `LoanSummaryCards.test.tsx`, `OverpaymentSimulator.test.tsx`, `LoanAmortizationReport.test.tsx`, `DebtPayoffTimelineReport.test.tsx`, `AccountInfoWidget.test.tsx` | the frontend rows of table 5.6, with `payment_amount` null on the fixture account so a reader that still uses it fails | P2-F1 |
| Frontend unit | `loan-schedule-methods.test.ts` | tables 7.1, 7.3, 7.4 and 7.5 from `generateLoanSchedule`; re-levelling not applied to the new methods | P2-F1 |
| Frontend unit | `MortgageFields.test.tsx`, `LoanPaymentSetupDialog.test.tsx` | one Select, four options, help text; Term Length shown for every type; `prepayment_mode` shown for LINEAR only; the first installment read-only | P1-F2, P2-F1 |
| Frontend contract | `mortgage-type.contract.test.ts` | the parity fixture | P1-F1 |
| Backend unit | `mortgage-type-detection.util.spec.ts`, `loan-mortgage-account.mortgage-type-detection.spec.ts` | table 10; the history route reads one rate period of posted installments and writes nothing | P2-B2 |
| Frontend unit | `MortgageTypeDetector.test.tsx`, `MortgageTypeHistoryDetector.test.tsx`, `mortgage-type-detection.contract.test.ts` | the suggestion is applied only when accepted; every reason code worded | P2-F2 |
| E2E | none | no spec under `e2e/` drives the mortgage form or names the old checkboxes, so there was nothing to move; the Select is asserted by `MortgageFields.test.tsx`. E2E is optional for INV-LOAN-007 (`docs/verification-contract.md` section 3) | P1-F2 |
