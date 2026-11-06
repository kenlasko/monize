# Spec: mortgage fees on the scheduled payment

Status: **draft for review**, requested in discussion #1968. Scope confirmed
with the maintainer: create and edit, mortgages only, an annual or per-payment
basis chosen per fee, and a balance-based fee repriced every occurrence. The plan that executes it is
[`docs/future-plans/mortgage-fees.md`](../future-plans/mortgage-fees.md).

A mortgage payment often collects more than principal and interest: mortgage
insurance, property tax held in escrow, an administration fee. This spec lets a
person define those **fees** on the mortgage. Each one becomes its own
categorized line on the auto-generated scheduled bill, priced by its own rule.
Fees are optional: a mortgage with none behaves exactly as it does today.

## 1. Terms

| Term | Meaning |
| --- | --- |
| Fee | One row of `loan_fees`: a name, a category, a calculation, a value and a basis. |
| Fee line | The template's `scheduled_transaction_splits` row that carries the fee's category. It is an ordinary category line (no transfer). |
| Loan portion | The bill minus its fee lines: what the existing loan pricing divides into principal, interest and extra principal. |
| Bill | The parent amount: loan portion plus every fee line. |

## 2. Data model

`loan_fees` (user-owned, direct RLS policy, one row per fee):

| Column | Type | Rule |
| --- | --- | --- |
| `id` | `UUID` | primary key |
| `user_id` | `UUID NOT NULL` | the account owner; `ON DELETE CASCADE` |
| `account_id` | `UUID NOT NULL` | the mortgage; `ON DELETE CASCADE` |
| `category_id` | `UUID NOT NULL` | the caller's own category; `ON DELETE CASCADE` |
| `name` | `VARCHAR(100) NOT NULL` | written as the fee line's memo |
| `calculation` | `VARCHAR(30) NOT NULL` | `FIXED`, `PERCENT_CURRENT_BALANCE`, `PERCENT_ORIGINAL_BALANCE` |
| `basis` | `VARCHAR(20) NOT NULL` | `PER_PAYMENT` or `ANNUAL` |
| `amount` | `NUMERIC(24,8)` | set exactly when `calculation = 'FIXED'`; `> 0` |
| `rate` | `NUMERIC(10,6)` | set exactly when the calculation is a percentage; `> 0` and `<= 100` (percent) |
| `sort_order` | `INTEGER NOT NULL DEFAULT 0` | display order |

`UNIQUE (account_id, category_id)`: one fee per category per mortgage. The
category is how a template line is identified as that fee's (section 4), so two
fees on one category would make the identification a guess. The service also
refuses a fee whose category is the mortgage's interest category, and the
interest-category change refuses a category a fee holds.

## 3. Pricing a fee for one installment

`priceLoanFee(fee, facts)` in `backend/src/loan-installments/loan-fees.ts`, a
pure function:

```text
base = FIXED                     -> amount
       PERCENT_CURRENT_BALANCE   -> debt(D) * rate / 100
       PERCENT_ORIGINAL_BALANCE  -> originalPrincipal * rate / 100
fee  = basis PER_PAYMENT -> base
       basis ANNUAL      -> base / periodsPerYear
result = fee rounded to the currency's minor unit (half away from zero)
```

- `debt(D)` is the ledger debt through the installment's date, the same figure
  the interest line accrues on (`datedLoanDebt`, INV-LOAN-006). A fee on the
  current balance therefore falls as the mortgage is paid down.
- `originalPrincipal` is `accounts.original_principal`, else
  `|accounts.opening_balance|`. When neither is positive the fee is **unknown**
  and the installment declines, naming the fee (an unknown is not 0).
- `periodsPerYear` is the stored cadence's (`periodsPerYearForStoredFrequency`),
  defaulting as `periodicRateFor` does, so the fee and the interest of one
  installment use one count.
- A fee is money the bank debits, so it is booked in whole minor units at
  pricing time; the template, the posting and the projection carry the same
  figure.

### 3.1 Worked examples (CAD, monthly, 12 payments a year)

| Fee | Calculation | Basis | Value | Facts | Line |
| --- | --- | --- | --- | --- | --- |
| Mortgage insurance | FIXED | PER_PAYMENT | 50 | | 50.00 |
| Property tax | FIXED | ANNUAL | 3,600 | | 300.00 |
| Default insurance | PERCENT_CURRENT_BALANCE | ANNUAL | 0.5 | debt 400,000 | 166.67 |
| Admin fee | PERCENT_ORIGINAL_BALANCE | PER_PAYMENT | 0.02 | original 400,000 | 80.00 |
| Property tax, biweekly | FIXED | ANNUAL | 1,000 | 26 payments | 38.46 |

A 2,000.00 principal and interest installment with the first four fees is a
bill of 2,596.67. After a year at 390,000 debt the default insurance line is
162.50 and the bill 2,592.50; the other lines do not move.

## 4. Identifying fee lines

`identifyLoanTemplate(splits, loanAccount, fees)` gains the configured fees. A
category line with no transfer whose category is a configured fee's, and is not
the interest line, is that fee's line. The template stays **managed** when every
line is the principal, the interest, the extra principal or a fee line; any other
line still makes it unmanaged, as an escrow line does today. Two lines on one fee
category leave the second unaccounted for, so the template is unmanaged rather
than priced from a guess.

Identification is by category, not by memo or position, for the reason the
interest line is (INV-LOAN-010): the configured category is the explicit
statement, and it reads the same on a template, an override's lines and a posted
row.

## 5. What each pricing purpose does with the fee lines

The existing loan pricing is unchanged; it prices the **loan portion**.

| Purpose | Fee lines | Loan portion priced from | Bill written or answered |
| --- | --- | --- | --- |
| `template`, `reconfigure`, `sync` | repriced at the template's `next_due_date` (section 3) | the template's loan portion and the dated payment, as today | loan total + fees |
| `posting` | the template's lines as stored: the bill shown is never resized | template bill minus its fee lines | loan total + fees |
| `settlement` | not supported in this release (section 8) | | |

- A rewrite writes a fee line only when its amount changed, and the parent when
  the bill changed, in the same transaction as the other lines.
- A posting whose stored bill is smaller than its fee lines declines (the loan
  portion would be negative); the persisted amounts post, as for any shape the
  pricing does not account for.
- **A retired debt ends the fees.** The fees are collected with the mortgage
  payment, so when the debt is retired the posting moves no money and the
  advancement deactivates the schedule, as for a template without fees.
- The rate-change sync preview (`buildScheduledUpdate`) reports the bill,
  fees included, as the current and proposed payment.

## 6. Projection

`projectLoanOccurrences` carries the fee lines in the template chain: the
cursor's are the stored lines, every later slot's are repriced at that slot's
folded debt, exactly what the advancement would write. Each occurrence's
`amount` is the bill; a new `fees` field lists `{ categoryId, amount }` per
fee line, and the existing `principal`, `interest` and `extraPrincipal` keep
describing the loan portion. An override with its own lines identifies fee lines
by category as the template does; one that states only an amount re-divides that
amount minus the chain's fees.

The client mirror (`loanOccurrenceLines`, `frontend/src/lib/loan-occurrence.ts`)
recognises a line whose category is in the occurrence's `fees` and fills it from
there, so the Post and override dialogs show each occurrence's fees.

## 7. Writing fees

- **Create.** `POST /accounts` for a mortgage accepts `loanFees` (at most 10).
  The first installment is priced on the opening debt and the template is
  written with one line per fee after the principal and interest lines, the
  parent being the bill. One transaction, with the account.
- **Edit.** `PUT /accounts/:id/loan-fees` replaces the mortgage's fee set (at
  most 10) and answers the new set. Inside one `withScopedDb` transaction, the
  account row is locked, then the schedule row (the order section 5 of
  `docs/concurrency-and-idempotency.md` gives); every refusal runs before the
  first write. The template is then synced: a removed fee's line is deleted, a
  new fee gets a line (adopting the template's one existing line on that
  category if there is exactly one, refusing when there are several), and
  every fee line is repriced at the template's `next_due_date`. The parent
  moves by exactly the change in fee lines, so the loan lines and the parent
  stay equal to the sum of the children even when the rest of the template is
  one the loan pricing declines. Overrides already written for later
  occurrences are the person's statement and are not touched. A fee whose
  category stays in the set keeps its row and id; only a fee that leaves is
  deleted.
- **Payment setup.** A mortgage can hold fees before its payments exist (an
  account created without them). `setupLoanPayments` reads them and writes one
  line per fee into the template it creates, priced on the debt the first
  installment is priced from; `firstInstallmentAmount` is then the bill.
- **Read.** `GET /accounts/:id/loan-fees` answers the set in `sort_order`.
- Only a `MORTGAGE` account takes fees; every other type is refused (400).

Refusals, all before any write: a category that is not the caller's; a category
twice in one request; the interest category; a value outside its bounds or on the
wrong calculation; more than 10 fees; a mortgage that is not the caller's (404);
a fee on a mortgage that has a payment matching rule (section 8).

## 8. Out of scope, and what it does today

- **Payment matching.** The settlement planner does not identify fee lines; a
  fee-carrying template reads as `managedTemplate` missing, the refusal an
  escrow line already gets, and the bank row is left for the person. So fees
  and a matching rule are refused together (400) on every path that writes
  either: the mortgage create, the payment setup, the rule create from Loan
  Details (`createMatchingRule`) and the fee replace. Removing fees from a
  mortgage with a rule is allowed. A later phase prices the fees at the slot
  and books them as their own lines of the settled row.
- **The rate-change sync preview** reports the loan's installment on both
  sides, fee lines left out, as the upcoming stated payments beside it are.
- Fees on `LOAN` and `LINE_OF_CREDIT` accounts.
- Fees in the amortization report and the payoff projections: they are not
  principal or interest and do not change the debt.

## 9. Invariant

**INV-LOAN-011** -- a mortgage fee line is priced from its own terms at the
installment's date, and the bill is the loan portion plus its fee lines. Held by
`priceLoanFee`, `identifyLoanTemplate`'s fee lines and the purposes table above;
`docs/system-invariants.md` has the entry.

## 10. Test matrix

| Case | Where |
| --- | --- |
| The five rows of 3.1; a falling balance; whole yen; unknown original principal | `backend/src/loan-installments/loan-fees.spec.ts` |
| A template with fee lines is managed; a second line on a fee category is not; the interest category is never a fee line | `backend/src/loan-installments/loan-fees.spec.ts` |
| `template` reprices a balance fee and bills loan + fees; `posting` keeps the stored fee lines and re-divides the rest; a bill below its fees declines; an unpriceable fee declines | `backend/src/loan-installments/loan-fees.spec.ts` |
| The rewrite writes a changed fee line and parent = loan + fees | `backend/src/loan-installments/loan-fees.spec.ts` |
| The projection's chain reprices the balance fee per slot and `amount` includes fees | `backend/src/loan-installments/loan-fees.spec.ts` |
| Posting returns fee lines and a parent equal to their sum | `backend/src/scheduled-transactions/scheduled-transaction-loan.service.spec.ts` |
| Create writes fee lines and the bill; fees with payment matching, on the interest category or on another user's category refused | `backend/src/accounts/loan-mortgage-account.service.spec.ts`, `backend/src/accounts/accounts.service.spec.ts` |
| Replace: add, adopt, remove, reprice, parent delta, refusals before writes | `backend/src/loan-fees/loan-fees.service.spec.ts` |
| Interest category change to a fee category refused; a fee line stays managed across a change | `backend/src/accounts/loan-interest-category.spec.ts` |
| Client line roles with fees | `frontend/src/lib/loan-occurrence.test.ts` |
| Drafts, inputs and client-side refusals | `frontend/src/lib/loan-fees.test.ts` |
| Fee editor in the mortgage form and the loan detail panel | `frontend/src/components/accounts/MortgageFields.test.tsx`, `frontend/src/components/accounts/loan-detail/LoanFeesPanel.test.tsx` |
| The replace (add, remove, refusal before writes), a fee-carrying posting and its advancement, and the one-fee-per-category index, against PostgreSQL | `backend/test/integration/mortgage-fees.integration.spec.ts` |
