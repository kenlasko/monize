# Spec: loan installment settlement

Status: implemented (Q, the final task of the task list, closes the
feature). The plan is `docs/future-plans/loan-installment-settlement.md`,
the task list `docs/future-plans/loan-installment-settlement-tasks.md`.
Governs: issue #1589 (tracking) and its sub-issues #1590 to #1602, agreed in
discussion #1486 and in the planning session recorded on #1589.
Registers INV-LOAN-008 and INV-RULE-005 in `docs/system-invariants.md`
(status `enforced`, flipped by the final task, Q), extends INV-LOAN-006
with a fourth consumer, and restates INV-RULE-001, INV-RULE-003,
INV-OCCURRENCE-001 and INV-CACHE-001 for the new action.

Read `docs/financial-semantics.md` sections 2 and 9,
`docs/financial-calculation-contract.md` sections 1, 7 and 8,
`docs/specs/scheduled-loan-installment-pricing.md`,
`docs/specs/mortgage-types.md` and
`docs/specs/transaction-rules-structural-actions.md` before changing anything
here. This document is the authority every later task's fixtures are copied
from: a fixture that disagrees with section 9 is wrong, or this document is,
and the disagreement is resolved here first, in its own commit.

## 1. Goal and scope

A bank such as ING NL posts one monthly mortgage debit on the current account
with no principal/interest breakdown. A rule recognises that row and turns it
into a split -- a principal transfer to the loan account, an interest category
line, and an extra-principal transfer when the row paid more -- priced by the
installment engine for the occurrence it pays, and records that the Scheduled
Bill occurrence is settled, without creating a second transaction. It works for
imported history and for every later import.

In scope:

- Loan accounts of type `MORTGAGE` (every mortgage type: `ANNUITY`,
  `CANADIAN_FIXED`, `LINEAR` in both prepayment modes, `INTEREST_ONLY`) and
  `LOAN` (an annuity, `docs/specs/mortgage-types.md` section 1).
- One currency: the row's account and the loan account have the same currency
  (the shared `transfer_currency_mismatch` refusal, section 11).

Out of scope, each refused by name:

- `LINE_OF_CREDIT`: a revolving facility has no installment to settle
  (`loan_account_unavailable`).
- A loan with `interest_booking_mode = SEPARATE`: the user books interest as a
  standalone expense, so a split carrying an interest line would count it twice
  (`loan_interest_booked_separately`).
- A schedule whose template carries a line that is not principal, interest or
  extra principal (an escrow, tax or insurance line): the row's share of it
  cannot be priced (`loan_not_configured`, missing `managedTemplate`).
- Cross-currency settlement, a settlement of an income row, and a settlement
  of a row that is already a transfer leg or a split.

## 2. Definitions

| Term | Meaning |
| --- | --- |
| row | The bank transaction a rule matched: a top-level, non-void expense (amount < 0) in the source account. `paid = abs(row.amount)`. |
| source account | The row's account. The rule created by the mortgage form fixes it in the condition (decision 5). |
| loan | The action's `loanAccountId`: a `MORTGAGE` or `LOAN` account of the same owner. |
| schedule | The loan's scheduled payment, `accounts.scheduled_transaction_id` (`docs/specs/scheduled-loan-installment-pricing.md` section 2). Never "any schedule with a transfer into the loan". |
| slot | One date of the schedule's calendar (section 6.1): the history dates stepped from `scheduled_transactions.start_date`, then `next_due_date` and the dates stepped from it, each step `calculateNextDueDate(previous, frequency)` (`backend/src/common/recurrence.ts`, the function `post()` advances with). `next_due_date` is always a slot, so the installment `post()` would claim next and the one a settlement claims share one key. A slot is an occurrence's identity, `original_due_date`; an override's moved date is not a slot. |
| period | The dates a slot answers for (section 6.1): from the slot to the next slot, the cursor's period also covering any gap a moved `next_due_date` left before it. |
| installment number | The slot's ordinal on the calendar (the first slot = 1). |
| claim | A `scheduled_transaction_postings` row of the schedule, whoever wrote it (`post()` or a rule). A claim occupies the slot whose period holds its `original_due_date`. |
| window | For a row dated `t`: `[t - daysAfter, t + daysBefore]`, inclusive. A slot `s` is in the window when the row is at most `daysBefore` days before it or at most `daysAfter` days after it. Dates compare as `YYYY-MM-DD` calendar days, never through a `Date` with a time. |
| pass | One planning of several rows before any of them is written: a manual run's preview or commit, or `applyToNew` over several ids. |
| `debtLedger(s)` | `datedLoanDebt(loan, s)` (`backend/src/accounts/dated-loan-debt.util.ts`): the canonical as-of debt through `s`, inclusive. |
| `debtBefore` | The debt the installment for slot `s` is priced on: `debtLedger(s)` minus the principal and extra principal of every settlement planned earlier in the same pass, not yet written, on the same loan, whose row is dated on or before `s` (section 7.2). |
| priced | An amount at storage precision (`roundMoney`, 4dp). |
| booked | An amount in the currency's smallest unit (`currencyMinorUnitDecimals`), through `bookLoanAllocation`: total and interest rounded to the unit, principal the remainder, never more principal than the debt (`docs/specs/mortgage-types.md` decision 7, amended). |
| `unit` | `10^-decimals`: 0.01 for EUR and USD, 1 for JPY, 0.001 for KWD. |
| `tol` | `LOAN_SETTLEMENT_TOLERANCE_MINOR_UNITS * unit` = `5 * unit`: 0.05 EUR, 5 JPY, 0.005 KWD. |
| `P`, `I`, `E` | The booked principal, interest and standing extra principal of the slot. `B = P + I` is the base installment; `T = B + E` the priced total. |

All money in the tables below is printed at cents unless the column says 4dp.

## 3. Decisions

Decisions 1 to 10 were agreed on #1589; 11 to 21 are made here and are the
review surface of this document.

1. **One typed structural action**, `settle_loan_installment` (section 5.1).
   The user never types an amount: the stored shape has no amount field and
   validation refuses an unknown one. At most one structural action per rule
   (`DUPLICATE_ACTION`), and it conflicts with `set_category`
   (`CONFLICTING_ACTIONS`), as `split` does.
2. **Amount policy.** Both parts are priced for the matched slot;
   `d = paid - T`. Within `tol` the interest line absorbs `d`. Above it:
   `extra_principal` (default) adds the excess to one extra-principal transfer
   line (memo `Extra Principal`, merged with a standing extra line; refused
   when principal plus extra would exceed `debtBefore`), or `refuse`. Below
   it: `refuse` (default), or `interest_first` (interest `min(I, paid)`,
   principal the rest). Same defaults for every method. Truth table in
   section 8.
3. **Claim the occurrence.** `scheduled_transaction_postings` gains
   `transaction_id`, `source`, `rule_id` and `pricing` (section 5.2). The claim
   is inserted on the `EntityManager` that writes the split, inside the one
   `withScopedDb` transaction; a unique-index conflict refuses with
   `occurrence_already_posted`. When the claimed slot is the schedule's
   `next_due_date`, the cursor advances through `advanceScheduleCursor`, the
   function `post()` calls. Deleting the settling transaction releases the
   claim only; voiding keeps it. `post()` starts writing `transaction_id`.
4. **Loans covered:** `MORTGAGE` and `LOAN`; a `LINE_OF_CREDIT` is refused
   (`loan_account_unavailable`), and so is `interest_booking_mode = SEPARATE`
   (`loan_interest_booked_separately`).
5. **Rule creation.** The mortgage form and the loan-payment setup dialog gain
   a "Payment matching" section; saving creates the rule through
   `TransactionRulesService.create` (conditions: account = source, type =
   expense, payee text matches the pattern, optionally description matches;
   triggers `create` and `import`; `stopProcessing`; appended at the end of the
   order), stores its id in `accounts.payment_matching_rule_id`, and sets
   `auto_post = false` on the linked schedule.
6. **Existing loans.** Loan Details gets a "Payment matching" panel: the linked
   rule or a dialog to create one, "Process history" (section 14), a warning
   when the schedule has `auto_post` on, and the settled installments read from
   the claims.
7. **Chronological fold (INV-RULE-005).** A pass that contains the action
   orders candidates by date ascending and prices each row against
   `debtBefore` (section 7.2); preview and commit compute the same fold, and
   the fingerprint includes `debtBefore`. Imports (QIF, OFX, CSV, MNY, bank
   sync) sort rows by date, for every user, before rules run.
8. **Opening-debt precondition.** The loan's opening balance must be the debt
   at the start of the imported history, and `original_principal` becomes a
   form field separate from the opening balance (section 14.3).
9. **Lock order.** Schedule row, then `lockAccountsForBalanceWrite(source,
   loan)`, as `post()` takes them, after a run's transaction-row locks
   (section 13).
10. **Expand only.** The migration adds nullable columns and a defaulted
    `source`; nothing is dropped.
11. **The boundary is the slot, not the row's date.** Interest and principal
    are priced at the matched slot `s` (debt, rate and remaining count through
    `s`), as the template is priced at its due date. The bank charges the
    installment for the due date; pricing at the row's date would make the
    installment depend on how many days the bank took to debit it. `post()`
    keeps its own boundary (`postDate`, the pricing spec section 2); the two
    answer different questions (what a bill moves on the day it is posted,
    what a bank debit paid for a due date).
12. **The annuity payment at a slot is the dated payment.** For an annuity
    (`LOAN`, `ANNUITY`, `CANADIAN_FIXED`) the configured installment at slot
    `s` is the `new_payment_amount` of the latest `loan_rate_changes` row
    effective on or before `s` that carries one, else
    `accounts.payment_amount` -- the rule `datedAnnuityPayment`
    (`backend/src/loan-installments/price-installment.ts`) states, dated
    at `s`. Not the template's amount: the template is a snapshot for
    `next_due_date` that may hold a one-off clamp, and history spans payment
    changes. The two sources hold different figures: a `manual` or
    `inferred` row's `new_payment_amount` states the base installment `B`
    (the rate-change resync adds the standing extra on top of it), while
    `accounts.payment_amount`, and an `initial` row's verbatim copy of it,
    hold `B + E` as `LoanPaymentSetupService` stores them. The settlement
    therefore prices `payment(s) + E` from a stated base and
    `accounts.payment_amount` as it stands, so `B` is that figure less the
    template's standing extra line. `LINEAR` and `INTEREST_ONLY`
    installments are derived (`methodPrincipal`,
    `docs/specs/mortgage-types.md` table 4.3) and read no payment.
13. **The standing extra is discretionary.** `E` is the template's
    extra-principal line as it stands (the rule the posting purpose applies;
    only a template rewrite grows it toward `accounts.extra_payment_amount`)
    when the schedule's template carries one, else 0, passed through
    `allocateLoanPayment` so it is clamped to the debt. A row short of `T` but
    not of `B` pays a smaller extra rather than being a shortfall, because
    `allocateLoanPayment` already sheds the extra first when a payment falls
    short. The excess and shortfall policies apply beyond `T` and below `B`
    respectively (section 8).
14. **A within-tolerance difference that would make interest negative is a
    shortfall.** It is then refused under the default `refuse`, and booked
    interest-first under `interest_first`, so the outcome is always defined.
15. **The plan always carries the principal and interest lines**, even at
    0.00 (an `INTEREST_ONLY` principal, a 0 % rate), because that is the shape
    `post()` writes (`docs/specs/mortgage-types.md` section 9) and the shape
    the payment-history readers pair. The extra line is present only when
    non-zero. Memos are `Principal`, `Interest` and `Extra Principal`, the
    memos `LoanPaymentSetupService` writes and `resolveInstallment` identifies
    lines by.
16. **A missing rate is unknown, not 0 %**, and an unknown cadence is not 12
    periods: the settlement refuses (`loan_not_configured`). The posting
    path's own defaults (`datedAnnualRate` falls back to 0, `periodicRateFor`
    to `DEFAULT_PERIODS_PER_YEAR`) are unchanged by this work and reported in
    section 15, not fixed in passing.
17. **The claim is the backstop, written after the split.** `writeEffects`
    writes the split through `writeSplit`, then inserts the claim with `ON
    CONFLICT DO NOTHING RETURNING id` on the same `EntityManager`; zero rows
    throws `ConflictException` (`errors.transactionRules.occurrenceAlreadyPosted`)
    and the caller's transaction rolls the split, its counterpart legs and the
    claim back together. The decision that a slot is taken is the planner's
    (`occurrence_already_posted`, section 11), made before any write from the
    claims the facts loader reads under the schedule row lock (section 13), so
    on the ordinary path the write-time conflict is unreachable: the `INSERT`
    is the database's own guarantee against a plan made on stale facts, not a
    second decision point. Recording the conflict as a skipped action instead
    would mean re-planning the row after its field patch was written, and in
    a manual run committing something other than the fingerprinted preview;
    a throw rolls back everything and keeps INV-RULE-003. The claim's
    `transaction_id` is the matched row, which already exists. Both writes
    share the `EntityManager`, so neither commits without the other.
18. **A refusal names what is missing.** `RuleSkippedAction` gains an optional
    `detail`; the settlement reasons carry it (section 11), so the preview,
    the trace and the Loan Details panel say which field to set or which slot
    is taken.
19. **Defaults are written on save.** The validator stores every optional
    field of the action with its default, so a stored rule never depends on a
    default a later release might change.
20. **The slot calendar is built around the cursor.** `next_due_date` is
    always a slot, history slots step from `start_date` up to the cursor's
    installment, and a claim occupies the period it paid (section 6.1). A
    calendar drawn only from `start_date` would let a bill post and a
    settlement of one installment take two keys once the user moved the
    bill's date. `ONCE` is a single slot; a schedule whose cadence is not the
    loan's is refused.
21. **Deleting a posted transaction releases its claim, for every
    schedule.** Once `post()` records `transaction_id`, the one foreign key
    cascades for its claims as for a settlement's (section 5.2); an
    investment post records none.

## 4. Invariants

### 4.1 INV-LOAN-008 (new): one settlement per occurrence, the claim atomic with the split

An occurrence `(schedule, slot)` has at most one claim, whoever wrote it; a
transaction settles at most one occurrence; and a settlement's claim is
written and rolled back with its split, and released when the settling
transaction is deleted. (It is not "exists exactly when the split exists":
a person who edits the lines down to one un-splits the row and the claim
stays, section 15.) Mechanisms:

- **One claim per occurrence:** the existing unique index `idx_stp_occurrence`
  on `(scheduled_transaction_id, original_due_date)`. `post()` and the
  settlement both claim with `INSERT ... ON CONFLICT DO NOTHING RETURNING id`
  through it, so a bill post and a settlement of the same slot cannot both
  succeed, in either order, on any replica. The key is the same for both
  because the calendar always holds `next_due_date` as a slot (section 6.1)
  and a settlement of the cursor's installment claims that date; a claim at a
  date the calendar no longer holds still occupies the period it paid.
- **One occurrence per transaction:** a partial unique index on
  `scheduled_transaction_postings (transaction_id) WHERE transaction_id IS NOT
  NULL`.
- **Claim with the split:** the split
  (`TransactionSplitService.createSplits`), its counterpart legs, the claim
  `INSERT` and the cursor advance run on one `EntityManager` inside one
  `withScopedDb` transaction (decision 17 orders them); a rollback drops all
  of them.
- **Release on delete:** `transaction_id` references `transactions(id) ON
  DELETE CASCADE`, so deleting the settling transaction (or undoing its
  create) deletes the claim in the same statement. The cursor is not rewound
  (section 12.5).
- **Undo is last-in, first-out per schedule:** the run undo refuses
  `RULE_RUN_UNDO_LATER_SETTLEMENT`, before any write, when the schedule has a
  claim the run did not write on a slot later than any slot the run claimed
  on it, so later than the earliest (section 12.6). A foreign claim between
  two of the run's slots counts: a run that settled January and March, then
  a February settled by a later create, priced February on January's
  principal. A later settlement was priced on a debt
  that includes this run's principal; removing it underneath would leave that
  settlement's interest priced on a debt that no longer existed.

### 4.2 INV-RULE-005 (new): a pass that settles folds chronologically

A pass that contains a `settle_loan_installment` action plans its candidates
oldest first (`applyRegisterOrder(..., "ASC")`), and prices each row on
`debtBefore`: the debt `datedLoanDebt` will read at the slot once every
settlement planned earlier in the pass is written. A slot planned earlier in
the pass is claimed for every later row. Mechanisms:

- `priorSettlements`, the settlements planned and not yet written, threaded
  through `TransactionRulesRunService.plan()` and `applyToNew` into the pure
  planner, so the preview and the commit fold through the same code. A
  settlement already written in the same transaction is in the ledger and is
  not in `priorSettlements`, so nothing is subtracted twice.
- `canonicalChanges` includes `changes.loanSettlement`, whose `pricing`
  carries `debtBefore`, so a commit whose fold came out differently from its
  preview refuses with `PREVIEW_CHANGED` (INV-RULE-003).
- The import paths (QIF, OFX, CSV through `ImportRegularProcessorService`,
  MNY through `applyImportRules`, bank sync through `BankSyncWriterService`)
  sort their rows by date ascending, stable within a date (file order kept),
  for every user, before any rule runs.

### 4.3 INV-LOAN-006 (extended): a fourth consumer, bounded by the matched slot

The settlement prices through the one pricing core (the body of today's
`resolveInstallment`, extracted by B2 into `backend/src/loan-installments/`):
the same `datedLoanDebt`, `effectiveAnnualRateOn`, type-keyed periodic rate,
`methodPrincipal`, `allocateLoanPayment` and `bookLoanAllocation`. Its
boundary is the matched slot (decision 11). The pricing spec's section 2
table carries the row.

### 4.4 INV-RULE-001 (restated for the action)

A settlement never changes the matched row's amount, account, date or status:
`writeEffects` sets only `isSplit` and `categoryId` on the row, as for a
`split`.
The only balance it moves is the loan's, by the counterpart legs of its
principal and extra-principal lines, each written through
`TransactionSplitService.createSplits` by exactly its line's amount. The
source account's balance does not move, because the row's amount does not
change. The plan's lines sum to the row's amount at 4dp by construction
(section 8), so `split_sum_mismatch` is unreachable; a property test asserts
it over the truth table's inputs.

### 4.5 INV-RULE-003 (extended)

The settlement plan (slot, `debtBefore`, booked lines, outcome) is part of the
planned changes and of the run fingerprint, alongside `changes.structure`.

### 4.6 INV-OCCURRENCE-001 (a second writer, and release on delete)

One scheduled occurrence has at most one financial effect. The settlement is
a second path to an occurrence's effect and goes through the same claim key
(4.1); it adds no effect beside the row's own, which already exists. From B5
a claim also names its transaction, and deleting that transaction releases
the claim for every schedule (section 5.2): the occurrence then has no
effect, and a person can post it again only by moving the cursor back onto
it. B5 records this in the INV-OCCURRENCE-001 entry.

### 4.7 INV-CACHE-001

Every caller of the write dispatches, after its commit and never inside the
transaction, the net-worth recompute for the loan account
(`affectedAccountIds`) and the loan template reprice (`rewriteLoanTemplate`,
the extracted `recalculateLoanPaymentSplits` body) for each schedule a
settlement claimed on. Bank sync starts dispatching for the loan account,
which it did not need to before. The run undo dispatches both for what it
reversed.

## 5. Data model

### 5.1 The stored action

```json
{
  "type": "settle_loan_installment",
  "loanAccountId": "<uuid>",
  "dueDateWindow": { "daysBefore": 3, "daysAfter": 7 },
  "excess": "extra_principal",
  "shortfall": "refuse",
  "interestCategoryId": "<uuid, optional>"
}
```

| Field | Values | Default (written on save) |
| --- | --- | --- |
| `loanAccountId` | an account of the rule's owner | required |
| `dueDateWindow.daysBefore` | integer 0..31 | 3 |
| `dueDateWindow.daysAfter` | integer 0..31 | 7 |
| `excess` | `extra_principal`, `refuse` | `extra_principal` |
| `shortfall` | `refuse`, `interest_first` | `refuse` |
| `interestCategoryId` | a category of the rule's owner, or absent | absent: `accounts.interest_category_id` of the loan |

The limit 31 is `MAX_LOAN_SETTLEMENT_WINDOW_DAYS` in
`backend/src/transaction-rules/transaction-rules.limits.ts`. Validation
(`rule-validation.ts`): an unknown field, a non-integer or out-of-range day
count, or an unknown policy is refused; `DUPLICATE_ACTION` beside another
structural action; `CONFLICTING_ACTIONS` beside `set_category`. References
(`rule-references.ts`): the loan account and the interest category are
checked for ownership with the rule's other references. Target accounts
(`rule-target-accounts.ts`): the loan account is a target, so it is locked,
reported in `affectedAccountIds` and refused by the shared target-account
refusals.

Name form (assistant, MCP; B8): `loanAccountName`, `interestCategoryName`;
`dueDateWindow`, `excess` and `shortfall` as stored.

### 5.2 `scheduled_transaction_postings`

| Column | Type | Meaning |
| --- | --- | --- |
| `transaction_id` | `UUID NULL REFERENCES transactions(id) ON DELETE CASCADE` | The transaction that paid the occurrence: the settled row (source `rule`); for source `post`, the row `post()` wrote in the schedule's own account (the transaction `TransactionsService.create` returned, or the source leg `writeTransferLegs` wrote). Null for an investment post (`postInvestment` writes through the investment service, and nothing here reads which of its rows paid), for a `post()` that wrote no money (a retired debt), and for every row written before B5. |
| `source` | `VARCHAR(8) NOT NULL DEFAULT 'post'`, `CHECK (source IN ('post', 'rule'))` | Who claimed it. |
| `rule_id` | `UUID NULL REFERENCES transaction_rules(id) ON DELETE SET NULL` | The rule whose action settled it; null for `post`. |
| `pricing` | `JSONB NULL` | The settlement's pricing record (5.3); null for `post`. |

`post()` inserts its claim before it creates the transaction (the claim is
its serialization point), so B5 sets the column afterwards in the same
transaction: `UPDATE scheduled_transaction_postings SET transaction_id = $tx
WHERE id = $claimId`.

**A change for every schedule, by decision.** Once `post()` writes
`transaction_id`, the cascade covers its claims too: deleting a posted bill
transaction (of any schedule, not only a loan's) deletes its claim, where
today the claim outlives the transaction. INV-OCCURRENCE-001 still holds --
the occurrence had one effect and now has none -- and the cursor is not
rewound, so nothing re-posts it on its own: the auto-post cron reads the
cursor, which has moved on. What changes is that a person who moves
`next_due_date` back onto that date can post it again, where today `post()`
answers "already posted" for an occurrence whose transaction is gone. The
alternative, `ON DELETE SET NULL` for post claims only, cannot be expressed
on one foreign key, and a second column for the same fact would let the two
disagree. The INV-OCCURRENCE-001 entry names this when B5 lands.

Plus `CREATE UNIQUE INDEX ... ON scheduled_transaction_postings
(transaction_id) WHERE transaction_id IS NOT NULL`, and
`CHECK (source = 'post' OR transaction_id IS NOT NULL)`: a rule claim always
names its transaction. Existing rows take `source = 'post'` from the default.
The table stays RLS-scoped through `scheduled_transactions.user_id` (its
existing policy); `transaction_id` and `rule_id` are the same owner's by
construction, because the planner only reads the owner's rows and rules.

### 5.3 The `pricing` record

Money is a string, so JSON never rounds it: the ledger and priced figures at
4dp, the booked, paid and written figures at the currency's unit. The
periodic rate is the double the interest was multiplied by.

```json
{
  "version": 1,
  "dueDate": "2024-02-01",
  "installmentNumber": 2,
  "method": "LINEAR",
  "prepaymentMode": "SHORTEN_TERM",
  "currencyCode": "EUR",
  "debtLedger": "300000.0000",
  "foldedPrincipal": "1033.3300",
  "debtBefore": "298966.6700",
  "annualRate": "2",
  "periodicRate": 0.0016666666666666668,
  "priced": { "principal": "833.3333", "interest": "498.2778", "extra": "0.0000", "total": "1331.6111" },
  "booked": { "principal": "833.33", "interest": "498.28", "extra": "0.00", "total": "1331.61" },
  "paid": "1331.61",
  "difference": "0.00",
  "outcome": "exact",
  "lines": { "principal": "833.33", "interest": "498.28", "extra": "0.00" }
}
```

`method` is `mortgageTypeOf(account)` for a mortgage (the type fixes both the
compounding and the amortization method, so `CANADIAN_FIXED` is kept apart
from `ANNUITY`) and `LOAN` for a `LOAN`; `prepaymentMode` is null off
`LINEAR`. `booked` is
what the slot charges; `lines` is what was written after the policy, which
differs from `booked` by the absorbed tolerance, the excess or the shortfall.
`outcome` is one of `exact`, `tolerance`, `extra_principal`, `extra_shed`,
`interest_first` (section 8). The same object, without `version`, is the
trace's `changes.loanSettlement.after.pricing`.

### 5.4 `accounts.payment_matching_rule_id`

`UUID NULL REFERENCES transaction_rules(id) ON DELETE SET NULL`: the rule the
"Payment matching" section created for this loan. Deleting the rule clears
it; the Loan Details panel then offers to create one. It is a pointer for the
UI only: the planner reads the rule's action, never this column.

## 6. Occurrence selection

### 6.1 The calendar

`post()` claims, and advances, whatever date `next_due_date` holds, and that
column can be edited apart from `start_date` and the frequency (the schedule
update path writes `nextDueDate` alone). A calendar drawn only from
`start_date` would then key a settlement on `YYYY-MM-01` and the bill on
`YYYY-MM-28` for one installment, and the unique index could not see that
both paid it. So the calendar is built around the cursor (`occurrence-slots.ts`,
pure):

1. **The cursor and after:** `next_due_date`, then each
   `calculateNextDueDate(previous, frequency)`, bounded by `end_date` when set
   and by `occurrences_remaining` when set (the cursor counts as one).
2. **History:** `start_date` and each next date stepped from it, keeping a
   date `D` only while `calculateNextDueDate(D, frequency) <= next_due_date`.
   The start-calendar date whose next step passes the cursor is the
   installment the cursor now stands for, so it is not a slot of its own;
   when the cursor is on the start calendar, history plus the cursor is the
   start calendar exactly.
3. **Periods:** a history slot answers for `[D, next(D))`; the cursor answers
   for `[h, next(cursor))`, where `h` is the end of the last history period
   (or `start_date` when there is none, or the cursor itself when
   `start_date` is after it), so a gap a moved cursor left belongs to it; a
   later slot `f` answers for `[f, next(f))`.
4. **Occupied:** a slot is occupied when a claim's `original_due_date` lies
   in its period. A claim `post()` wrote at a date the calendar no longer
   holds (before the cursor moved) still blocks the installment it paid.
5. **`ONCE`:** `calculateNextDueDate` returns its input, so the calendar is
   the single slot `next_due_date`. Defensively, any step that does not move
   forward ends the enumeration.
6. **Cadence:** the calendar uses the schedule's current `frequency`
   throughout. For a loan the schedule's cadence must be the loan's: when
   `accounts.payment_frequency` is set and
   `periodsPerYearForStoredFrequency` gives the two a different count, the
   action refuses `loan_not_configured` with `missing: ["scheduleCalendar"]`.
   A cadence changed on both after history began redraws the history at the
   new cadence, which nothing records; section 15 names it.

Enumeration covers only the dates the pass's windows reach.

### 6.2 Selection

Given a row dated `t` and the calendar:

1. The candidates are the slots in the window `[t - daysAfter, t + daysBefore]`.
   None: `no_installment_in_window`.
2. Drop every occupied slot, and every slot a settlement planned earlier in
   the same pass took. None left: `occurrence_already_posted`.
3. Take the slot nearest to `t` in calendar days; on a tie, the earlier slot.

The settlement's claim is keyed on the chosen slot's own date, so a
settlement of the cursor's installment claims `(schedule, next_due_date)`,
the key `post()` would use.

### 6.3 Truth table

Schedule monthly with `start_date` 2024-01-01 and `next_due_date` on that
calendar unless the row says otherwise; window 3/7 unless it says otherwise.

| # | Row date `t` | Claimed | Window | Answer |
| --- | --- | --- | --- | --- |
| 1 | 2024-01-01 | none | 2023-12-25 .. 2024-01-04 | 2024-01-01 (installment 1) |
| 2 | 2024-01-04 | none | 2023-12-28 .. 2024-01-07 | 2024-01-01 (3 days late) |
| 3 | 2024-01-08 | none | 2024-01-01 .. 2024-01-11 | 2024-01-01 (7 days late, inclusive) |
| 4 | 2024-01-09 | none | 2024-01-02 .. 2024-01-12 | `no_installment_in_window` |
| 5 | 2023-12-29 | none | 2023-12-22 .. 2024-01-01 | 2024-01-01 (3 days early, inclusive) |
| 6 | 2023-12-28 | none | 2023-12-21 .. 2023-12-31 | `no_installment_in_window` (before the schedule's start) |
| 7 | 2024-01-05 | 2024-01-01 | 2023-12-29 .. 2024-01-08 | `occurrence_already_posted` (2024-02-01 is outside) |
| 8 | 2024-01-29 | none | 2024-01-22 .. 2024-02-01 | 2024-02-01 (installment 2, 3 days early) |
| 9 | 2024-01-05 | 2024-01-01 planned earlier in the pass | as row 7 | `occurrence_already_posted` |
| 10 | 2024-01-07, weekly from 2024-01-01 | none | 2023-12-31 .. 2024-01-10 | 2024-01-08 (1 day before beats 6 days after) |
| 11 | 2024-01-07, weekly from 2024-01-01 | 2024-01-08 | as row 10 | 2024-01-01 (the nearest unclaimed) |
| 12 | 2024-01-08, biweekly from 2024-01-01, window 7/7 | none | 2024-01-01 .. 2024-01-15 | 2024-01-01 (tie of 7 days, the earlier) |
| 13 | 2024-03-01, `end_date` 2024-02-15 | none | 2024-02-23 .. 2024-03-04 | `no_installment_in_window` (2024-03-01 is past the end) |
| 14 | 2024-03-29; claims 2024-01-01, 2024-02-01; `next_due_date` moved from 2024-03-01 to 2024-03-28 | as stated | 2024-03-22 .. 2024-04-01 | 2024-03-28: the cursor; the claim is `(schedule, 2024-03-28)` and the cursor advances to 2024-04-28. Slots: 2024-01-01, 2024-02-01 (history), 2024-03-28, 2024-04-28, ... |
| 15 | 2024-03-02; as row 14 | as row 14 | 2024-02-24 .. 2024-03-05 | `no_installment_in_window`: 2024-03-01 is not a slot, the cursor stands for that installment |
| 16 | 2024-02-03; claim 2024-02-15 (a post made while the cursor was moved), `next_due_date` back on 2024-03-01 | 2024-02-15 | 2024-01-27 .. 2024-02-06 | `occurrence_already_posted`: the claim lies in 2024-02-01's period |
| 17 | 2024-05-02; `ONCE`, `next_due_date` 2024-05-01 | none | 2024-04-25 .. 2024-05-05 | 2024-05-01, the only slot |
| 18 | any; schedule `BIWEEKLY`, loan `payment_frequency` `MONTHLY` | -- | -- | `loan_not_configured`, `missing: ["scheduleCalendar"]` |
| 19 | 2024-03-29; claims 2024-01-01, 2024-02-01; `next_due_date` moved from 2024-03-01 to 2024-05-28 (two installments skipped) | as stated | 2024-03-22 .. 2024-04-01 | 2024-04-01 (history slot; 2024-03-01 and 2024-04-01 are history, 2024-05-01 is the cursor's) |

A claim by `post()` and a claim by a rule are the same claim for step 2. A
slot before the cursor that was never posted has no claim and can be settled
(history); a slot after it can be settled too (an early bill). Overrides are
not read: a slot is its recurrence date, and an override's moved date is
neither a slot nor a window anchor in this version (section 15).

## 7. Pricing at the slot

### 7.1 Inputs

Every input is dated at the slot `s` (decision 11) and read by the facts
loader (`loan-settlement-facts.ts`) after the locks of section 13:

| Input | Source | Missing |
| --- | --- | --- |
| `debtLedger(s)` | `datedLoanDebts(loan, slots)`: one statement for every slot of the pass, equal date by date to `datedLoanDebt` | the account row cannot be read: `loan_account_unavailable` |
| annual rate | `effectiveAnnualRateOn(loan_rate_changes, s, accounts.interest_rate)` | null: `loan_not_configured`, missing `rate` |
| periodic rate | `getPeriodicRate(rate, ppy, mortgageTypeOf(account))` for a mortgage, `rate / 100 / ppy` for a loan; `ppy = periodsPerYearForStoredFrequency(account.payment_frequency or schedule.frequency)` | unknown cadence: missing `paymentFrequency` |
| principal, `LINEAR` and `INTEREST_ONLY` | `methodPrincipal` through `nonAnnuityInstallment` with `debtBefore` and `s` (`docs/specs/mortgage-types.md` table 4.3, `remaining(s)` from `payment_start_date`) | `missingMethodTerms`: each name it returns |
| payment, annuity | decision 12 | neither a dated payment nor `accounts.payment_amount`: missing `payment` |
| standing extra `E` | decision 13 | -- (0 when the template has no extra line) |
| interest category | the action's `interestCategoryId`, else `accounts.interest_category_id` | missing `interestCategory` |

### 7.2 The fold

`debtBefore(row) = debtLedger(s) - sum(lines.principal + lines.extra)` over
the settlements planned earlier in the same pass and not yet written, on the
same loan, whose row date is on or before `s`. The condition on the row date
is what makes the fold equal to the ledger the commit leaves: a counterpart
leg is dated on its row's date, so `datedLoanDebt(s)` will include it exactly
when that date is on or before `s`.

Where a caller writes each row before planning the next (a REST create, the
per-row import processor, and `applyToNew` over several ids, which drops the
loan's cached facts after each settlement it writes so the next row reads
the claims and the debts the write left), the earlier settlements are already
in the ledger and `priorSettlements` is empty; where it plans several rows
before writing (the manual run), `priorSettlements` carries them. Both give
the same `debtBefore` for the same rows.

`debtBefore <= 0.01` refuses `loan_debt_retired` (the threshold
`resolveInstallment` reads as paid off).

### 7.3 The priced installment

1. Interest: `roundMoney(debtBefore * periodicRate)`.
2. Principal: annuity `payment(s) - interest`; `LINEAR` and `INTEREST_ONLY`
   the method principal (7.1).
3. `allocateLoanPayment({ paymentAmount: principal + interest + E (annuity:
   payment(s) + E), extraPrincipal: E, interest, principal, currentBalance:
   debtBefore })`: interest first, principal clamped to the debt, the extra
   shed first.
4. `bookLoanAllocation(allocation, decimals, debtBefore)` gives `P`, `I`, `E`
   and `T`.

The pure function is `priceInstallment` (`price-installment.ts`, B2), called
here with the slot's inputs and by `resolveInstallment` with its own; one
function, two callers' missing-data rules (decision 16).

## 8. Amount policy

`paid = abs(row.amount)`, `d = paid - T`, at 4dp. The first row that matches
decides. Lines are written with the row's sign (negative); the counterpart
legs in the loan are positive.

| # | Condition | `excess` | `shortfall` | Lines: principal / interest / extra | `outcome` or refusal |
| --- | --- | --- | --- | --- | --- |
| 1 | `d = 0` | any | any | `P` / `I` / `E` | `exact` |
| 2 | `0 < abs(d) <= tol` and `I + d >= 0` | any | any | `P` / `I + d` / `E` | `tolerance` |
| 3 | `d > tol` and `P + E + d <= debtBefore` | `extra_principal` | any | `P` / `I` / `E + d` | `extra_principal` |
| 4 | `d > tol` and `P + E + d > debtBefore` | `extra_principal` | any | -- | `installment_amount_excess` |
| 5 | `d > tol` | `refuse` | any | -- | `installment_amount_excess` |
| 6 | `E > 0` and `B <= paid < T` (reached only when rows 1 and 2 did not apply: `paid < T - tol`, or a tolerance that would make interest negative) | any | any | `P` / `I` / `paid - B` | `extra_shed` |
| 7 | `E > 0` and `B - tol <= paid < B` and `I + (paid - B) >= 0` | any | any | `P` / `I + (paid - B)` / none | `tolerance` |
| 8 | otherwise: `paid < B - tol`, or a row 2 or 7 difference that would make interest negative | any | `refuse` | -- | `installment_amount_shortfall` |
| 9 | as row 8 | any | `interest_first` | `paid - min(I, paid)` / `min(I, paid)` / none | `interest_first` |

The table is total: rows 1 to 5 cover `d >= -tol` with interest non-negative,
rows 6 and 7 cover a short extra (row 6 every `paid` from `B` up to `T` that
rows 1 and 2 left, so a row that paid the whole base installment is never a
shortfall, decision 13), and rows 8 and 9 everything else. In every
written row the lines sum to `paid`.

`LOAN_SETTLEMENT_TOLERANCE_MINOR_UNITS = 5`, why five minor units:

- **It covers rounding, not money.** A bank prices the same installment with
  its own rounding (per day, per step, its own half-rule), and the engine
  books interest and total to the unit separately; two independently rounded
  figures differ by up to a unit, and a bank's day-count or rounding
  convention leaves a few more. Five units covers that, and a repeated
  observed gap of 0.01 to 0.04 on a correct ledger is what the requester's
  statements show.
- **It is far below a real payment change.** No one overpays a mortgage by
  0.05; an extra repayment is at least a whole currency unit, so anything
  above `tol` is treated as money (rows 3 to 5).
- **It is in minor units of the account's currency**, so it scales with what
  a bank can debit: 0.05 EUR, 5 JPY, 0.005 KWD. A fixed 0.05 would be a
  tenth of a yen nobody can pay, or fifty fils.
- **It lands on interest**, because the principal is the method's figure and
  the ledger's debt depends on it (a LINEAR constant principal, decision 8 of
  the mortgage-types spec); the interest is the bank's computation that
  rounds differently. A difference that would make interest negative is not
  a rounding (decision 14).

## 9. Worked examples (the fixtures)

Produced independently of the implementation: each figure below was
computed from the formulas of section 7 with `roundMoney` at each step and
booked to cents, not copied from any program's output. A fixture copied
from the implementation proves nothing about it.

### 9.1 LINEAR, EUR

EUR 300,000, 360 months, 2.00 %, monthly, `SHORTEN_TERM`, schedule and
`payment_start_date` 2024-01-01. `docs/specs/mortgage-types.md` table 7.1
rows 1 and 2. `c` = 833.3333; `tol` = 0.05.

Slot 1, `debtBefore` 300,000.00: priced 833.3333 + 500.0000 = 1,333.3333;
booked 833.33 + 500.00 = 1,333.33.

| # | Row | Lines: principal / interest / extra | `outcome` | Loan moves by |
| --- | --- | --- | --- | --- |
| L1 | -1,333.33 | 833.33 / 500.00 / -- | `exact` | +833.33 |
| L2 | -1,333.35 | 833.33 / 500.02 / -- | `tolerance` | +833.33 |
| L3 | -1,333.30 | 833.33 / 499.97 / -- | `tolerance` | +833.33 |
| L4 | -1,333.39 | 833.33 / 500.00 / 0.06 | `extra_principal` (0.06 is above `tol`) | +833.39 |
| L4r | -1,333.39, `excess: refuse` | -- | `installment_amount_excess` | 0 |
| L5 | -1,533.33 | 833.33 / 500.00 / 200.00 | `extra_principal` | +1,033.33 |
| L6 | -1,533.33, `excess: refuse` | -- | `installment_amount_excess` | 0 |
| L7 | -1,300.00 | -- | `installment_amount_shortfall` | 0 |
| L8 | -1,300.00, `shortfall: interest_first` | 800.00 / 500.00 / -- | `interest_first` | +800.00 |

Slot 2 (2024-02-01), priced on `debtBefore`:

| # | Before it | `debtBefore` | Priced (4dp) | Booked | Row | Lines |
| --- | --- | --- | --- | --- | --- | --- |
| L9 | L1 written | 299,166.67 | 833.3333 + 498.6111 = 1,331.9444 | 833.33 + 498.61 = 1,331.94 | -1,331.94 | 833.33 / 498.61 (`exact`) |
| L10 | L5 written | 298,966.67 | 833.3333 + 498.2778 = 1,331.6111 | 833.33 + 498.28 = 1,331.61 | -1,331.61 | 833.33 / 498.28 (`exact`) |

At cents, L1 and L9 are table 7.1's rows 1 and 2 (833.33, 500.00, 1,333.33;
833.33, 498.61, 1,331.94): a ledger of cents prices 299,166.67 / 600 =
498.6111, as the 4dp ledger's 299,166.6667 does.

### 9.2 ANNUITY, EUR

A `LOAN` (or a mortgage of type `ANNUITY`), EUR 200,000, 6.00 % nominal,
monthly (periodic 0.005), payment 1,500,
`docs/specs/scheduled-loan-installment-pricing.md` section 5. Slot 1:
interest 1,000.0000, principal 500.0000, booked 500.00 + 1,000.00 = 1,500.00.

| # | Row | Lines: principal / interest / extra | `outcome` |
| --- | --- | --- | --- |
| A1 | -1,500.00 | 500.00 / 1,000.00 / -- | `exact` |
| A2 | -1,500.04 | 500.00 / 1,000.04 / -- | `tolerance` |
| A3 | -1,700.00 | 500.00 / 1,000.00 / 200.00 | `extra_principal` |
| A4 | -1,450.00 | -- | `installment_amount_shortfall` |
| A5 | -1,450.00, `interest_first` | 450.00 / 1,000.00 / -- | `interest_first` |
| A6 | slot 2 after A1, `debtBefore` 199,500.00, row -1,500.00 | 502.50 / 997.50 / -- | `exact` |

The pricing spec's section 5 rows through the same code: `debtBefore`
198,500 prices 992.50 interest and 507.50 principal; 198,000 prices 990.00
and 510.00.

### 9.3 Edges

| # | Case | Priced and booked | Row | Answer |
| --- | --- | --- | --- | --- |
| E1 | INTEREST_ONLY, 300,000 at 2.00 %, slot 1 | 0.00 + 500.00 = 500.00 | -500.00 | 0.00 / 500.00 / -- (`exact`; the 0.00 principal line is kept, decision 15) |
| E2 | as E1 | as E1 | -700.00 | 0.00 / 500.00 / 200.00 (`extra_principal`) |
| E3 | as E1, `interest_first` | as E1 | -450.00 | 0.00 / 450.00 / -- (`interest_first`) |
| E4 | ANNUITY 6 %, `debtBefore` 1,000.00 | principal min(1,495.00, 1,000.00) = 1,000.00 + interest 5.00 = 1,005.00 | -1,005.00 | 1,000.00 / 5.00 / -- (`exact`, retires the loan) |
| E5 | as E4 | as E4 | -1,105.00 | `installment_amount_excess` (1,000.00 + 100.00 > 1,000.00) |
| E6 | ANNUITY 0 %, payment 500.00 | 500.00 + 0.00 = 500.00 | -499.97 | `installment_amount_shortfall` (interest would be -0.03; decision 14) |
| E7 | as E6, `interest_first` | as E6 | -499.97 | 499.97 / 0.00 / -- (`interest_first`) |
| E8 | LINEAR slot 1 with a standing extra of 100.00 | 833.33 + 500.00 + 100.00 = 1,433.33 | -1,433.33 | 833.33 / 500.00 / 100.00 (`exact`) |
| E9 | as E8 | as E8 | -1,533.33 | 833.33 / 500.00 / 200.00 (`extra_principal`, one merged line) |
| E10 | as E8 | as E8 | -1,383.33 | 833.33 / 500.00 / 50.00 (`extra_shed`) |
| E11 | as E8 | as E8 | -1,333.31 | 833.33 / 499.98 / -- (row 7, `tolerance`) |
| E12 | as E8 | as E8 | -1,300.00 | `installment_amount_shortfall` (below `B` - `tol`) |
| E13 | LOAN, JPY 30,000,000 at 1.2 %, monthly, payment 120,000 | 90,000 + 30,000 = 120,000 | -120,004 | 90,000 / 30,004 / -- (`tolerance`, `tol` = 5 JPY) |
| E14 | as E13 | as E13 | -120,006 | 90,000 / 30,000 / 6 (`extra_principal`) |
| E15 | `debtBefore` 0.01 | -- | any | `loan_debt_retired` |
| E16 | ANNUITY 0 %, `payment_amount` 600.00 (base 500.00 plus the standing extra 100.00, decision 12) | 500.00 + 0.00 + 100.00 = 600.00 (`B` 500.00) | -599.97 | 500.00 / 0.00 / 99.97 (`extra_shed`: row 2 would make interest -0.03, row 6 takes it) |

### 9.4 The fold in one pass

LINEAR as 9.1, nothing settled yet, one manual run over:

| Row | Date | Slot | `debtLedger(s)` | Folded | `debtBefore` | Lines |
| --- | --- | --- | --- | --- | --- | --- |
| -1,533.33 | 2024-01-03 | 2024-01-01 | 300,000.00 | 0.00 | 300,000.00 | 833.33 / 500.00 / 200.00 |
| -1,331.61 | 2024-02-02 | 2024-02-01 | 300,000.00 | 1,033.33 | 298,966.67 | 833.33 / 498.28 (`exact`) |

Planned newest first, or without the fold, the second row would price on
300,000.00, expect 1,333.33, and be refused `installment_amount_shortfall`
for a payment the bank computed correctly. The second row is dated after
its own slot: once written, its counterpart (dated 2024-02-02) is outside
`debtLedger(2024-02-01)` and inside `debtLedger(2024-03-01)`, which is what
the fold's date condition says for a third row in the same pass.

### 9.5 Occurrence selection

The issue's two cases are rows 2 and 7 of section 6.3: a row dated 2024-01-04
with window 3/7 matches 2024-01-01; a row dated 2024-01-05 with 2024-01-01
claimed and 2024-02-01 outside the window is `occurrence_already_posted`.

## 10. Missing-data policy

A refusal, never a priced guess. Each names what is missing in its detail
(decision 18) so the reader knows what to set.

| Missing | Answer | Detail |
| --- | --- | --- |
| The loan has no scheduled payment (`accounts.scheduled_transaction_id` null, or the row gone) | `loan_not_configured` | `missing: ["scheduledPayment"]` |
| The schedule's template has a line beyond principal, interest and extra principal | `loan_not_configured` | `missing: ["managedTemplate"]` |
| The schedule's cadence is not the loan's (section 6.1, item 6) | `loan_not_configured` | `missing: ["scheduleCalendar"]` |
| No interest category on the action or the loan | `loan_not_configured` | `missing: ["interestCategory"]` |
| A LINEAR or INTEREST_ONLY term (`missingMethodTerms`) | `loan_not_configured` | `missing: ["amortizationMonths", "paymentStartDate", "paymentFrequency", "originalPrincipal"]`, those that apply |
| An unknown cadence on an annuity | `loan_not_configured` | `missing: ["paymentFrequency"]` |
| No rate at the slot (no `loan_rate_changes` row on or before it and a null `interest_rate`) | `loan_not_configured` | `missing: ["rate"]`, `dueDate` |
| No annuity payment at the slot (decision 12) | `loan_not_configured` | `missing: ["payment"]`, `dueDate` |
| The loan's account row or ledger cannot be read | `loan_account_unavailable` | -- |
| A database error while reading facts | Not a refusal: the error propagates and the caller's transaction rolls back, as any database error does on that path | -- |

A missing rate is unknown, not 0 %; an unknown cadence is not 12 periods; a
missing payment is not the template's amount. A zero debt is a known zero:
`loan_debt_retired`, not a missing figure.

## 11. Refusals

Each is a skipped action with a reason (`RuleSkippedAction`), decided by the
pure planner before any write; it never throws on a create or import path.
Checked in this order; the first that applies is the answer. The union of
"planned" and the reasons below is every outcome the planner returns for the
action.

| # | Reason | When | Detail |
| --- | --- | --- | --- |
| 1 | `structural_not_allowed_for_actor` | a create by a non-owner actor (`structuralNotAllowed`) | -- |
| 2 | `row_is_transfer_leg` | the row is, or an earlier rule made it, a transfer leg | -- |
| 3 | `row_has_splits` | the row is, or an earlier rule made it, a split | -- |
| 4 | `row_is_void` | the row is VOID | -- |
| 5 | `zero_amount` | the row's amount is zero or unknown | -- |
| 6 | `transfer_same_account` | the loan is the row's own account | -- |
| 7 | `transfer_account_unavailable` | the loan is not an account the planner was given (missing, or not the owner's) | -- |
| 8 | `transfer_currency_mismatch` | the loan's currency differs from the row's | -- |
| 9 | `row_from_scheduled_posting` | the row already pays an occurrence: the create carries the server-set `fromScheduledPosting` option (a transaction `post()` created), or a claim of either source names the row (a posted bill; a settled row edited down to one line, section 15 item 9) | -- |
| 10 | `row_is_income` | the row's amount is positive | -- |
| 11 | `loan_account_unavailable` | the loan is not `MORTGAGE` or `LOAN` (a `LINE_OF_CREDIT` included), is closed, or its row or ledger cannot be read | `accountType` |
| 12 | `loan_interest_booked_separately` | `interest_booking_mode = SEPARATE` | -- |
| 13 | `loan_not_configured` | a static input of section 10 is missing (scheduled payment, managed template, schedule calendar, interest category, method terms, cadence) | `missing` |
| 14 | `no_installment_in_window` | no slot in the window (section 6.2 step 1) | `windowFrom`, `windowTo` |
| 15 | `occurrence_already_posted` | every slot in the window is occupied or planned earlier in the pass (step 2) | `dueDates` |
| 16 | `loan_not_configured` | a dated input is missing at the chosen slot (rate, annuity payment) | `missing`, `dueDate` |
| 17 | `loan_debt_retired` | `debtBefore <= 0.01` | `dueDate` |
| 18 | `installment_amount_excess` | section 8 rows 4 and 5 | `dueDate`, `expected` (`T`), `paid`, `debtBefore` |
| 19 | `installment_amount_shortfall` | section 8 row 8 | `dueDate`, `expected` (`T`), `paid` |

`transfer_direction_mismatch`, `split_amount_unparseable`,
`split_sum_mismatch` and `split_too_few_parts` do not apply: the action has no
direction to mismatch (row 10 refuses an income), no captures, and lines that
sum to the row by construction. Rows 1 to 8 are the shared refusals of
`docs/specs/transaction-rules-structural-actions.md` section 4, in its order.
A conflict the claim `INSERT` finds at write time is not a refusal: under
the lock protocol of section 13 it is unreachable, and the write path throws
the backstop `ConflictException` rather than recording a refusal it did not
plan (decision 17).

## 12. Write path

### 12.1 Order inside the transaction

`TransactionRulesApplierService.writeEffects`, on the caller's
`EntityManager`: the field patch and tags as today (a settlement can share a
rule with tag, payee and description actions), then for a settlement:

1. the split, through `writeSplit` (`TransactionSplitService.validateSplits`,
   then `createSplits`), from the `SplitStructurePlan` the planner produced;
   `isSplit = true`, `categoryId = null` on the row.
2. the claim (`claim-loan-occurrence.ts`): `INSERT INTO
   scheduled_transaction_postings (scheduled_transaction_id,
   original_due_date, posted_date, transaction_id, source, rule_id, pricing)
   VALUES (..., 'rule', ...) ON CONFLICT DO NOTHING RETURNING id`, with
   `posted_date` the row's date and `rule_id` the rule that planned it. No
   row (a conflict on either unique index): the backstop `ConflictException`
   of decision 17, and the transaction rolls back.
3. the cursor (12.3).

The applier returns, per row, the schedule it claimed on
(`AppliedRuleRow.settledScheduleIds`), for the caller's after-commit reprice
(12.8).

### 12.2 Trace and fingerprint

The rule's trace entry carries `changes.structure = { before: null, after:
<split plan> }` as a `split` does, and `changes.loanSettlement = { before:
null, after: { loanAccountId, scheduledTransactionId, dueDate,
installmentNumber, pricing } }`; the stored trace adds `claimId` and the
cursor before and after. `canonicalChanges` includes `loanSettlement`
(`dueDate`, `debtBefore`, the booked figures, `lines` and `outcome`), so the
fingerprint changes with any of them.

### 12.3 The cursor

When the claimed slot equals the schedule's `next_due_date`, the cursor
advances through `advanceScheduleCursor` (B2 extracts it from `post()`, which
keeps calling it): `next_due_date` to the next slot, `occurrences_remaining`
decremented and the schedule deactivated at zero or past `end_date`,
overrides with `original_date` before the new cursor pruned,
`last_posted_date` set. It repeats while the new `next_due_date` already has
a claim on that date (a slot settled out of order before), so the bill does
not offer an occurrence whose own key is already claimed. The claim reads the
locked schedule row itself and compares `next_due_date` with the slot, never
the plan's `advancesCursor` alone. A cadence that does not step (`ONCE`, a
value outside `FrequencyType`) has no next slot: the settlement deactivates
the schedule with `last_posted_date` set, the claim-preserving counterpart of
the delete `post()` makes for a `ONCE` bill (deleting the schedule would
cascade to the claim). A claim on any other slot leaves the cursor where it
is: a slot before it is history, and a slot after it leaves the earlier
occurrence still due.

### 12.4 Run snapshot

Per settled row, on its `structure` record beside the existing split
snapshot (line and counterpart ids): the claim id, the schedule id, the slot
and `cursorAdvanced`; and when the claim advanced the cursor, the cursor
columns (`next_due_date`, `occurrences_remaining`, `is_active`,
`last_posted_date`) before and after that advance plus every override row it
pruned. A run can advance one schedule several times (X to Y, then Y to Z),
so the undo rewinds the rows in reverse run order: Z back to Y, then Y back
to X, each step conditional on the cursor still standing where that advance
left it (12.6). Before the write the size check measures the record with
placeholders, as it does the counterpart ids.

### 12.5 Delete, void, edit

- **Delete** of the settling transaction (or the undo of its create): the
  `ON DELETE CASCADE` on `transaction_id` deletes the claim in the same
  statement. The cursor is not rewound: a cursor move is a statement about
  the bill that a deletion does not reverse, and rewinding it could re-offer
  an occurrence the user has since posted. The slot is unclaimed and can be
  settled again by another row.
- **Void** keeps the claim. VOID moves no balance (INV-TRANSFER-001: the
  counterpart legs are voided with the row), and a voided settlement still
  names the occurrence it was for, so another row is not matched to it while
  the user decides; un-voiding restores it as it was. Deleting the voided
  transaction releases it.
- **Edit** of the lines after the settlement (`PUT /transactions/:id/splits`)
  is the person's statement and leaves the claim, which still names the
  transaction; the `pricing` record keeps what was priced. The run undo then
  refuses with the existing `RULE_RUN_UNDO_STRUCTURE_CHANGED`.

### 12.6 Undo of a run

Under the schedule row lock and the existing row and reconciled-lock checks,
before any write:

- refuse `RULE_RUN_UNDO_LATER_SETTLEMENT` when a schedule has a claim the
  run did not write on a slot later than the earliest slot the run claimed
  on it (4.1);
- refuse `RULE_RUN_UNDO_STRUCTURE_CHANGED` as today when a line was replaced.

Then remove the split lines and counterpart legs as a `split` undo does,
and, over the settled rows in reverse run order, delete each claim the run
wrote (`DELETE ... WHERE id = $claimId`; a claim already gone through a
deletion is skipped, not a change) and rewind each advance the snapshot
recorded, with `UPDATE scheduled_transactions SET <recorded before the
advance> WHERE id = $1 AND next_due_date = <recorded after the advance>`
(`rewindScheduleCursor`; a cursor the user has moved since is left as they
set it, and the overrides are then not re-inserted either), re-inserting the
overrides that advance pruned (`ON CONFLICT DO NOTHING`, so an override the
person has since re-created for the same occurrence stands). After the
commit, `ActionHistoryService.undo` dispatches `rewriteLoanTemplate` for the
schedules it released claims on (4.7). Redo stays refused
(`RULE_RUN_REDO_STRUCTURAL`).

### 12.7 Auto-post

The rule creation of decision 5 sets `auto_post = false` on the linked
schedule, and the Loan Details panel warns when it is on. If the auto-post
cron posts an occurrence first, its claim (`source = 'post'`) makes a later
bank row for that slot `occurrence_already_posted`, and the person has two
transactions for one installment to resolve; the rule does not delete either.
If the settlement claims first and the slot was the cursor, the cursor has
moved, so the cron posts the next occurrence, not this one; if the cron's
`post()` reaches a claimed slot anyway, the unique index refuses it with its
existing `ConflictException`.

### 12.8 After the commit

Every caller (REST create, the import processors, MNY, bank sync, the run)
dispatches, after its commit, the net-worth recompute for
`affectedAccountIds` (the loan) and `rewriteLoanTemplate` for each schedule
claimed on, so the next bill is priced on the ledger the settlement left
(INV-CACHE-001; INV-LOAN-006).

## 13. Locks and concurrency

Order, as `post()` takes them: the schedule row (`FOR UPDATE`), then
`lockAccountsForBalanceWrite(source, loan)` (ascending id), then the claim,
the split and the cursor. The facts (claims, `datedLoanDebts`, rates) are read
after the locks, so the debt is read under the lock that authorizes the write
(CONC-001).

- **The manual run** locks the rule `FOR SHARE`, the candidate rows ascending
  (`lockTransactionRows`), then plans once; the facts loader, asked to lock
  on the commit, takes the schedule row and then
  `lockAccountsForBalanceWrite(source, loan)` before its first read, inside
  that one plan and before any write. A rule holds at most one structural
  action, so a run reaches one schedule and one loan, and the loader's order
  is `post()`'s; the lock the run takes over its structure targets after the
  plan then finds the loan already held. (An earlier draft derived the
  schedules and loans from the rule and locked them before planning; with one
  loan per run the loader's locks are the same set in the same order, so the
  derivation was not built.)
- **A REST create** runs its rules before the source account's balance write
  (`TransactionsService.create`), so the settlement's schedule lock is the
  first lock its transaction takes on either, and its order is `post()`'s.
- **The import paths** write the source account's balance before the rules
  run, so the source is already held when the settlement takes the schedule
  row: the order inverts against a concurrent `post()` of the same schedule
  (section 15).

A bill post and a settlement of the same slot are serialized by the schedule
row lock, and if a path ever claims without it, by the unique index.
`scheduled-loan-pricing-concurrency.integration.spec.ts` is the model for the
two-connection proof B5 adds.

## 14. History

### 14.1 Order and the cap

A run is capped at `MAX_RULE_RUN_LIMIT` (1000) rows and reports `truncated`.
A run that contains the action scans oldest first, so its pages walk forward
through time. "Process history" is the ordinary run of the loan's
payment-matching rule over the source account, page by page: each next page
starts at the date of the previous page's last row (`startDate`, inclusive),
which the preview reports as `scannedThrough`.
Rows of that date that the previous page settled are now splits and are
refused `row_has_splits`, so a re-scan writes nothing twice. The loop stops
when a page is not truncated, and stops with an error naming the date when a
page's first and last rows share one date (more than 1000 rows on a day:
the scan cannot advance).

### 14.2 Imports

The import paths sort rows by date ascending, stable within a date, before
inserting them and running rules, for every user (decision 7). The release
note names it: a file's rows are inserted in date order whatever order the
file listed them in.

### 14.3 Preconditions

- **The opening balance is the debt at the start of the history.** Every
  `debtBefore` is the opening balance plus the ledger, so an opening balance
  that is not the debt immediately before the first settled slot prices every
  interest on a wrong debt. Understated, the priced total falls short of the
  bank's and the default `extra_principal` books the gap as extra principal;
  the run preview shows `debtBefore` and the extra line on every row so the
  person sees it before committing.
- **`original_principal` is the amount originally borrowed.** A LINEAR
  `SHORTEN_TERM` principal is `roundMoney(original_principal / N)`; the
  fallback `abs(opening_balance)` (`docs/specs/mortgage-types.md` section 8)
  is right only when the ledger starts with the loan. A loan of 300,000
  started in 2020 whose ledger opens at 260,000 in 2024 needs
  `original_principal` 300,000, or `c` is 722.22 instead of 833.33. The
  create and edit forms carry the field separately from the opening balance
  (B7, F2).
- **The schedule's calendar reaches back.** A row before the schedule's
  `start_date` has no slot (section 6.3 row 6). A mortgage created through the
  form starts its schedule at `payment_start_date`; a schedule set up later
  starts at its first due date, and history before it is refused
  `no_installment_in_window`. Setting up payment matching on such a loan
  states this (B7, F3).

## 15. Known gaps

Stated so they are not mistaken for coverage; none is closed by this spec.

1. **Import-path lock inversion.** On the import paths the source account is
   held before the settlement takes the schedule row (section 13), the
   reverse of `post()`. A person pressing Post on the matched bill while an
   import over the same source account settles the same schedule can
   deadlock; PostgreSQL aborts one transaction (`40P01`) and nothing of it is
   written. The unique index still allows one claim. The window is small
   because decision 5 turns auto-post off for the matched bill. Closing it
   means moving the import's balance write after its rules, as
   `TransactionsService.create` orders them; that is a separate proposal.
2. **Overrides are not read.** An occurrence the user moved with an override
   is still matched at its recurrence date (section 6).
3. **A slot posted with no claim row** (an occurrence posted before the claim
   table existed) is claimable. A bank row for it is normally refused earlier
   anyway: a loan payment `post()` wrote is a split or a transfer, refused
   `row_has_splits` or `row_is_transfer_leg`, and from B5 `post()` records its
   transaction on the claim.
4. **Delete does not rewind the cursor** (12.5), by decision.
5. **The posting path defaults a missing rate to 0 % and an unknown cadence
   to 12 periods** (`datedAnnualRate`, `periodicRateFor`). The settlement
   refuses both (decision 16); the posting path is unchanged and is reported
   here, not changed by this work.
6. **`createMortgageAccount` and `setupLoanPayments` stay several commits**: a
   rule-creation failure is reported and the account stays (#1589, noted).
7. **A cursor moved back into a paid period.** `post()` claims whatever date
   `next_due_date` holds and does not read periods; a person who moves the
   cursor back onto a date inside a period already claimed under another date
   can post that installment a second time. The settlement refuses that
   period (section 6.1, item 4); `post()` is unchanged by this work.
8. **A cadence changed on both the schedule and the loan** after history
   began redraws the history slots at the new cadence (section 6.1, item 6);
   nothing records the old one.
9. **Un-splitting a settlement.** Editing a settled row's lines down to one
   collapses the split (`isSplit` false) and the claim stays, naming a row
   that no longer carries the principal it was priced with. Deleting the row
   releases it.
10. **Deleting one settlement out of order.** The run undo is last in, first
    out (`RULE_RUN_UNDO_LATER_SETTLEMENT`), but deleting a single settling
    transaction, or undoing its create, while later settlements exist on the
    same schedule is allowed: the later ones keep the interest they were
    priced with on a debt that included the deleted principal. The ledger's
    balance stays exact (each leg moved what it says); the later rows' split
    between interest and principal is what is stale. Refusing or warning on
    that delete is a separate proposal.

## 16. Test matrix

| Task | Suite | What it asserts |
| --- | --- | --- |
| B1 | migration test, `scripts/verify-schema.sh`, `mortgage-type.contract.spec.ts`-style CHECK reconciliation | the columns, defaults, the `source` CHECK and the rule-claim CHECK; the partial unique index refuses a second claim for one transaction; deleting the transaction deletes the claim, for a `rule` and a `post` claim alike; deleting the rule nulls `rule_id` and `payment_matching_rule_id`; backup round-trips the new columns |
| B2 | `scheduled-transaction-loan.service.spec.ts`, `scheduled-transaction-loan.mortgage-methods.spec.ts`, `scheduled-transactions.service.spec.ts` unchanged; a loan-core import guard spec | behaviour-preserving extraction; `post()` advances through `advanceScheduleCursor`; the core imports nothing from `transactions/*`, `scheduled-transactions/*.service*` or `transaction-rules/*` |
| B3 | `occurrence-slots.spec.ts` | section 6.3, every row; the calendar of 6.1 (a moved cursor, periods, a claim off the calendar occupying its period, `ONCE`, a step that does not advance, `end_date` and `occurrences_remaining`) |
| B3 | `plan-loan-settlement.spec.ts` | section 8, every row and the totality property (lines sum to `paid`); section 9, every row; the fold of 9.4 and the "dated on or before `s`" condition; section 10; refusals 11 to 19 in order |
| B3 | `loan-settlement-facts.spec.ts`, a PG integration spec | `datedLoanDebts` equals `datedLoanDebt` date by date on a real ledger (VOID, split children and later rows excluded); a null rate and a missing payment reported as missing, never 0 |
| B4 | `rule-validation.structural.spec.ts`, `rule-effects.structural.spec.ts` | the action's validation, defaults written on save, the two combination codes; refusals 1 to 10 in order; the lookup rounds; a later rule sees `hasSplits` |
| B5 | `claim-loan-occurrence.spec.ts`, `schedule-cursor.spec.ts`, `transaction-rules-applier.settlement-write.spec.ts`, `rule-run-fingerprint.spec.ts`, `rule-run-snapshot.spec.ts`, `rule-run-undo.spec.ts`, `transaction-rules-run.structure-commit.spec.ts`, `scheduled-transactions.service.spec.ts` | the claim after the split with the written id and the rule id; the write-time conflict thrown as the backstop and unreachable when the planner saw the claim; the cursor (advance, repeat over claimed slots, no move off the cursor, a cadence that does not step deactivates); trace, fingerprint, snapshot; undo, `RULE_RUN_UNDO_LATER_SETTLEMENT`, two advances rewound in reverse order (X to Y to Z back to X), overrides restored; the facts read under the locks on the write paths; `post()` writes `transaction_id` after its create, null for an investment post; after-commit reprice and dispatch |
| B5 | PG integration (`loan-settlement-claim.integration.spec.ts`) and two connections | 9.2 A1 end to end with the loan balance, the claim and the cursor; a planted failure after the claim rolls all of it back; a second row for the slot refused with nothing written; delete releases the claim, void keeps it; a bill post and a settlement of one slot on two connections leave one claim; the template repriced after the commit |
| B6 | `transaction-rules-run.*.spec.ts`, import processor specs, bank sync specs | ascending order when a rule settles; 9.4 through preview and commit with equal fingerprints; `priorSettlements` never double-counts a written row; the import sort (stable within a date) on every import path; bank sync dispatches the loan account |
| F1 | `RuleEditor.structural-actions.test.tsx`, `RuleRunPreviewTable.test.tsx`, a skip-reason contract test | the action card; the preview shows `debtBefore`, the lines and the extra per row; every reason and `missing` code worded |
| B7 | `loan-mortgage-account.service.spec.ts`, `loan-payment-setup.service.spec.ts` | the rule created with section 3 decision 5's conditions and triggers, appended; `payment_matching_rule_id` set; `auto_post` off; `original_principal` stored separately; the settled-installments endpoint reads the claims |
| F2, F3 | `MortgageFields.test.tsx`, `LoanPaymentSetupDialog.test.tsx`, the panel's tests | Payment matching and Original principal fields; Process history pages forward and stops (14.1); the auto-post warning; the settled list |
| B8 | `rule-name-mapping.structural.spec.ts`, `rule-validation-hints.structural.spec.ts`, MCP rule tool specs | the name form both ways; hints for each validation code |
| Q | the specs above named in `docs/system-invariants.md` | INV-LOAN-008 and INV-RULE-005 flipped with their tests named; every locale |
