# Dated loan payment

Design for dating the annuity payment of a scheduled loan installment the way
its rate is already dated: the payment of an installment due on `D` is the one
the rate timeline states for `D`, the template advancement steps into a new
payment at the first installment it applies to, the rate-change sync prices
the template's own due date and asks before every write, and the occurrence
view prices each occurrence rather than repeating the template. The task list
is [`dated-loan-payment-tasks.md`](./dated-loan-payment-tasks.md). The rules,
truth tables and fixtures are in
[`docs/specs/scheduled-loan-installment-pricing.md`](../specs/scheduled-loan-installment-pricing.md)
sections 5.1 to 5.3, 7 and 8, and
[`docs/specs/mortgage-types.md`](../specs/mortgage-types.md) 5.3 and 5.6; this
plan says what to edit, in what order, and what to run, and defers to the spec
on every number and every refusal.

Status: **done** (B1 to B3, F1, F2, and Q, the acceptance task, all merged);
decisions agreed in the planning session and recorded on the tracking issue
#1637. Each task was a sub-issue (#1638 to #1644), one PR each. F3 (#1645),
filed for later, was approved afterwards and prices a loan bill's later
occurrences on the occurrence contract (spec 8.7).

## 1. Goal

- A mortgage whose rate change states 560.00 from 2023-04-15 bills 584.59 for
  2023-02-03, 2023-03-03 and 2023-04-03 and 560.00 from 2023-05-03, whatever
  the bill's `next_due_date` was when the change was recorded (spec 5.2).
- Recording, editing or deleting a rate change never rewrites the bill without
  the user's confirmation, prices the bill at its own due date, names the due
  date from which the bill changes, and leaves `accounts.payment_amount` alone
  (spec 7.5).
- The occurrence picker shows each date's amount, and the override editor
  pre-fills that occurrence's amount and its Principal and Interest lines
  (spec section 8).
- INV-LOAN-009 is enforced, named with its tests.

## 2. What exists, and what this composes

| Need | Existing piece | Notes |
| --- | --- | --- |
| One pricing path | `resolveInstallmentCore`, `priceInstallment`, `datedAnnualRate` (`backend/src/loan-installments/price-installment.ts`) | B1 adds `datedPaymentAmount` beside `datedAnnualRate` and passes the dated payment into `priceInstallment`. |
| The dated payment rule | `datedAnnuityPayment` (`backend/src/loan-installments/price-installment.ts`) | Already the settlement's rule (settlement spec decision 12). B1 moved it there from the settlement planner, beside `datedAnnualRate`; the planner imports it from there. |
| The template rewrite | `rewriteLoanTemplate` (`backend/src/loan-installments/reprice-template.ts`) | The advancement (B1) and the sync's apply (B2). |
| The slot calendar | `occurrenceSlotsInRange` (`backend/src/loan-installments/occurrence-slots.ts`) | Answers `prev(D)` for B1's `newly` (spec 7.3). |
| Occurrence identity | `expandOccurrenceSlots` (`backend/src/common/scheduled-occurrences.ts`) | The projection's occurrences (B3). |
| The dated debt | `datedLoanDebt`, `datedLoanDebts` (`backend/src/accounts/dated-loan-debt.util.ts`) | One statement for every projected date (B3). |
| Booking | `bookLoanAllocation` (`backend/src/accounts/loan-payment-waterfall.util.ts`) | The projection books as the posting books. |
| The rate-change sync | `buildScheduledUpdate`, `syncScheduledTransaction`, `applyScheduledPaymentSync`, `resolveCurrentTimeline` (`backend/src/loan-rate-changes/loan-rate-changes.service.ts`) | B2 replaces the pricing and the apply; the `deferScheduledSync` path of create becomes the only path. |
| The mortgage rate update | `updateMortgageRate` (`backend/src/accounts/loan-mortgage-account.service.ts`) | Calls the rate-change create; B2 brings it under the same pricing. |
| The next occurrence | `ScheduledOccurrenceService` (`backend/src/scheduled-transactions/scheduled-occurrence.service.ts`) | Unchanged; the projection's first occurrence equals its answer. |
| Rate-change dialogs | `useLoanRateEditing.ts`, `LoanRateControls.tsx`, `RateHistorySidebar.tsx` (`frontend/src/components/accounts/loan-detail/`), `frontend/src/lib/loan-rate-changes.ts`, `frontend/src/types/loan-rate-change.ts` | F1. |
| Occurrence view | `OccurrenceDatePicker.tsx`, `OverrideEditorDialog.tsx` (`frontend/src/components/scheduled-transactions/`), `frontend/src/lib/scheduled-transactions.ts`, `frontend/src/types/scheduled-transaction.ts` | F2. |

## 3. Decisions

The seven decisions are on the tracking issue and restated in the spec; the
ones that decide the shape of the work:

1. **The payment is dated by one function.** `datedAnnuityPayment` is the
   rule for the advancement, the settlement, the sync and the projection, so
   no consumer other than `reconfigure` (by decision, spec 7.6 item 3) reads
   `accounts.payment_amount` around it (spec 7.1).
2. **The advancement steps only when the payment newly applies** (spec 7.3);
   otherwise the `max` that keeps a user-raised template and the grow-back
   after a clamp stands. Posting is unchanged.
3. **The sync is a template rewrite, not a schedule edit.** It applies through
   `rewriteLoanTemplate`, so it cannot reach the schedule update's write of
   `accounts.payment_amount`; the preview and the apply are one function.
4. **The projection is a read through the same core** (spec section 8), never
   a second pricing implementation on the client.
5. **No repair script** (decision 6): a confirmed sync rewrites an affected
   template.

## 4. Order of work

| Phase | Tasks | What ships | Behaviour change |
| --- | --- | --- | --- |
| 0 | S1 | The spec sections, this plan, INV-LOAN-009 registered | none |
| 1 | B1 | The dated payment in the core and the advancement | An annuity template steps into a stated payment at the first installment it newly applies to |
| 2 | B2, B3 | The sync at the template's due date, asking on every change; the projection read | Editing or deleting a rate change no longer rewrites the bill until the user confirms; the preview carries two new fields; a new read nothing calls yet |
| 3 | F1, F2 | The confirmation on edit and delete; the priced occurrence picker and override editor | The dialogs show the due date and per-occurrence amounts |
| 4 | Q | Every locale, INV-LOAN-009 enforced, release note, dev data resynced | none |
| later | F3 | Loan occurrences after the next priced by `ScheduledOccurrenceService`, one year ahead | Every server surface and the occurrence read show a later loan occurrence at its projected amount (spec 8.7) |

B2 changes the response of `PATCH` and `DELETE /accounts/:accountId/rate-changes/:id`
(a preview, nothing applied) before F1 shows it: between the two merges an
edit or delete records the change and leaves the bill until the next
advancement or a create's confirmation. That is the safe direction (nothing is
written the user did not see); F1 follows B2 directly.

## 5. Where each rule is held

| Rule | Mechanism | Task |
| --- | --- | --- |
| The annuity payment is dated (INV-LOAN-009) | `datedAnnuityPayment` read by `datedPaymentAmount` inside `resolveInstallmentCore`; `priceInstallment` takes the payment as an input | B1 |
| The advancement steps into a new payment | `newly(D)` from the slot calendar in the template purpose; an `initial` row never newly applies | B1 |
| The sync prices its template's own due date | one plan function, called by the preview and the apply, at `next_due_date` | B2 |
| No rate-change path writes `accounts.payment_amount` | the apply goes through `rewriteLoanTemplate`; a spec asserting the account row is not saved and a source scan refusing `ScheduledTransactionsService.update` in the rate-change service | B2 |
| A rate change asks before it rewrites the bill | create, update and delete return a preview; only `apply-scheduled-payment` writes | B2, F1 |
| The occurrence view reads a server-priced occurrence (INV-OCCURRENCE-003) | the projection read; the picker and editor read it, never `scheduledTransaction.amount` for a loan bill | B3, F2 |
| The template rewrite invalidates the bill caches (INV-CACHE-001) | F1 invalidates the scheduled-transaction caches after the apply | F1 |
| The numbers | fixtures copied from spec sections 5, 7 and 8 | B1, B2, B3 |

## 6. Assumptions, restated for a fresh session

- The spec sections 5.1 to 5.3, 7 and 8 are the fixtures; they were computed
  from the formulas, not from an implementation.
- A slot is a recurrence date of the schedule; `prev(D)` is the slot before
  `D` on the calendar `occurrence-slots.ts` builds around `next_due_date`.
- "The schedule" of a loan is `accounts.scheduled_transaction_id`.
- A `manual` or `inferred` row states the base installment; an `initial` row
  and `accounts.payment_amount` hold base plus the standing extra (settlement
  spec decision 12).
- LINEAR and INTEREST_ONLY are untouched: their installment is derived per
  date already.
- Locales: English first in each task, `npm run i18n:pseudo` after editing
  `en/*`; the full-locale pass is Q.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| A user-raised template is replaced by a newly applying stated payment | By decision 2 (spec A8); the release note says so (Q) |
| A confirmed sync replaces a user-raised template with the timeline's figure at its due date, even for a change dated later | By decision 3 (spec 7.5, the A7 row); the preview shows the current and proposed figures before the user confirms, and the release note says so (Q) |
| A skipped slot misses the step into a lower payment | Named as a known gap (spec 7.6 item 1); the projection shows it, and re-running the sync repairs it |
| Edit and delete stop applying until F1 ships | F1 follows B2; the interim is "not yet applied", never a wrong write (section 4) |
| Templates written by the old sync stay wrong | Q resyncs the dev data; the release note tells users to confirm a sync (decision 6) |
| The projection and the posting disagree | Both price through `priceInstallment` with the posting purpose for the lines; B3 asserts the first occurrence's total and lines against `resolvePostingAllocation` on the same ledger, and its total against the stored template, which is what `ScheduledOccurrenceService` answers for a same-currency base occurrence |
