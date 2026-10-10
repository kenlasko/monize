# Dated Loan Payment: Agent Task List

> Companion to [`dated-loan-payment.md`](./dated-loan-payment.md) (the plan) and [`docs/specs/scheduled-loan-installment-pricing.md`](../specs/scheduled-loan-installment-pricing.md) sections 5, 7 and 8 (the spec). This file breaks the work into tasks sized for one AI-agent session each. Do the tasks in dependency order; never start a task whose dependencies are unmerged. Mark a task done by checking its box and noting the PR.

## How to use this list (read first, every session)

- **One task per session/PR.** Each task lists its files. Touching files outside the task's scope is a scope violation -- stop and leave a note on the task's issue instead.
- **The spec is the authority on every number.** A fixture is copied from spec sections 5.1 to 5.3, 7.4 (with its settlement rows), 7.5 and 8.6, never from the implementation's own output. If the code and the spec disagree, the spec is changed first, in its own commit, with the reason.
- **The governing invariants apply to every task:** the annuity payment is the one stated for the installment's own due date (INV-LOAN-009), beside the dated rate and debt (INV-LOAN-006); the occurrence view reads a server-priced occurrence (INV-OCCURRENCE-003); a template rewrite invalidates the bill caches (INV-CACHE-001). Name each one the task touches in the PR.
- **Definition of done for every task** (in addition to per-task acceptance):
  - `backend/`: `npm run lint && npx tsc --noEmit && npm run typecheck`, `npm run test:changed`; plus `npm run build && npm run test:integration` when a query, an entity or an RLS context changed.
  - `frontend/`: `npm run lint && npm run type-check && npm run i18n:check`, `npm run test:changed`, `npm run build`.
  - `docs/`: `node scripts/check-docs-manifests.mjs` and, in `backend/`, `npm run test:unit -- doc-paths instruction-files`.
  - No task in this list changes `database/`: no migration, no `database/schema.sql` edit.
  - Stage new files before running a guard (`git add -N` is enough).
  - New user-facing strings: English catalogs only, then `npm run i18n:pseudo`. The full-locale pass is Q.
  - A control an E2E spec drives that is renamed or removed: grep `e2e/` for its accessible name.
  - The doc line each task names lands in the same PR.
- **Terminology:** "the spec" = `docs/specs/scheduled-loan-installment-pricing.md`; "the plan" = `dated-loan-payment.md`; "the core" = `backend/src/loan-installments/`. Section references point to the spec. Re-locate code by symbol, never by line.

## Deployment safety

| Class | Meaning |
|-------|---------|
| **none** | Tests, docs, or code nothing calls yet. |
| **inert** | Ships an endpoint, a field or a code path that changes nothing until a client reads it or a user opens the dialog. |
| **neutral** | Rewrites a live code path. Behaviour-preserving for every existing user except where the task names a change; the full unit suite of the touched module is the gate. |

Every task is safe to merge in any order that respects its dependencies: nothing here migrates data, and every new field is additive.

## Task graph

| ID | Issue | Task | Depends on | Deploy class | Status | PR |
|----|-------|------|-----------|--------------|--------|----|
| S1 | #1638 | Spec sections and plan pair; INV-LOAN-009 registered `unenforced` | -- | none | [x] | the PR closing #1638 |
| B1 | #1639 | Dated payment in the pricing core and the template advancement | S1 | neutral | [x] | the PR closing #1639 |
| B2 | #1640 | Rate-change sync prices the template's own due date; confirm on create, update, delete; no `payment_amount` write | B1 | neutral | [x] | the PR closing #1640 |
| B3 | #1641 | Loan occurrence projection read | B1 | inert | [x] | the PR closing #1641 |
| F1 | #1642 | Rate-change dialogs: confirm on edit and delete, preview names the due date | B2 | inert | [ ] | |
| F2 | #1643 | Occurrence picker and override editor priced per occurrence | B3 | inert | [ ] | |
| Q | #1644 | Acceptance: INV-LOAN-009 enforced, locales, release note, dev data resync | B2, F1, F2 | none | [ ] | |
| F3 | #1645 | (Later, not approved) Bills calendar and Upcoming Bills priced per loan occurrence | B3 | inert | [ ] | |

**Why B1 is neutral:** an annuity template whose timeline states a payment for a later installment steps into it at that installment (spec 7.3), down as well as up; every other template advances exactly as before, and posting is unchanged.

**Why B2 is neutral:** editing or deleting a rate change stops rewriting the bill until the user confirms, and the sync prices a different date; the preview gains two fields the current client ignores.

**Why F1 follows B2 directly:** between the two, an edit or delete records the change and does not offer the sync (plan section 4).

---

## Task details

### S1 -- Spec sections and plan pair

**Files:** `docs/specs/scheduled-loan-installment-pricing.md` (sections 2, 4, 5.1 to 5.3, 6, 7 and 8), `docs/specs/mortgage-types.md` (5.3 and 5.6), `docs/future-plans/dated-loan-payment.md` and `docs/future-plans/dated-loan-payment-tasks.md` (new), `docs/system-invariants.md` (INV-LOAN-009, `unenforced`), `docs/verification-contract.md` (its matrix row).

- Acceptance: the truth tables and fixtures reproduce the worked example of #1637 at cents; every "never", "always" and "cannot" names its mechanism; the docs gate above passes.

### B1 -- The dated payment in the core and the advancement

**Files:** `backend/src/loan-installments/price-installment.ts`, `backend/src/loan-installments/plan-loan-settlement.ts` (imports the moved function), `backend/src/loan-installments/reprice-template.ts`, `backend/src/loan-installments/occurrence-slots.ts` (if `prev(D)` needs an export), `backend/src/scheduled-transactions/scheduled-transaction-loan.service.ts`, their specs, `backend/test/integration/dated-loan-payment.integration.spec.ts` (new).

- Move `datedAnnuityPayment` beside `datedAnnualRate`; add `datedPaymentAmount(m, loanAccount, asOfDate)`; `resolveInstallmentCore` reads it at `asOfDate` and passes the dated payment to `priceInstallment`, which stops reading `accounts.payment_amount` for the `template` purpose (spec 7.1, 7.2).
- The `template` purpose applies `newly(D)` (spec 7.3): `prev(D)` from the slot calendar of the schedule being rewritten, so `rewriteLoanTemplate` passes the schedule's `start_date`, `next_due_date` and cadence through to the core.
- `posting`, `settlement` and `reconfigure` price as spec 7.2 says; their existing specs stay green unchanged.
- Acceptance: every row of spec table 7.4 and of the settlement table after it (A1 to A16, S1 to S3) as a named case, and table 5.3's rows 16, 17, 29 and 30 through successive advancements; the settlement's existing cases unchanged; the integration case of spec section 6 (the advancement across a stated change on a real ledger).

### B2 -- The rate-change sync

**Files:** `backend/src/loan-rate-changes/loan-rate-changes.service.ts`, `backend/src/loan-rate-changes/loan-rate-changes.controller.ts`, `backend/src/accounts/loan-mortgage-account.service.ts` (`updateMortgageRate`), `backend/src/loan-installments/price-installment.ts` and `backend/src/loan-installments/reprice-template.ts` (the sync purpose, if B1 did not add it), their specs, `backend/test/integration/dated-loan-payment.integration.spec.ts`.

- One plan function prices the template at its own `next_due_date` through `resolveInstallmentCore` with the payment of spec 7.2's sync row; the preview returns it and `applyScheduledPaymentSync` writes it through `rewriteLoanTemplate` (spec 7.5). `buildScheduledUpdate`'s own arithmetic and its `max(effectiveDate, next_due_date)` go.
- `update` and `remove` return `scheduledPaymentPreview` and apply nothing, as `create` with `deferScheduledSync` does today; `create` loses the immediate-apply path. The mortgage rate update prices the template by the same function.
- `ScheduledPaymentPreview` gains `dueDate` and `nextPaymentChange` (spec 7.5).
- No rate-change path calls `ScheduledTransactionsService.update`: a source-scanning case in the service's spec fails such a call, and the apply's unit case asserts the account row is not saved.
- Acceptance: every row of spec table 7.5, the raised-template row included; Scenario 2 of #1637 (edit to 560.00) leaves the template at 584.59 and `accounts.payment_amount` unchanged; delete returns a preview and writes nothing until applied.
- Doc line: the "Until B2" clauses of `docs/specs/mortgage-types.md` 5.3 and 5.6 removed.

### B3 -- The loan occurrence projection read

**Files:** `backend/src/loan-installments/project-loan-occurrences.ts` (new, pure: the fold of spec 8.2), `backend/src/scheduled-transactions/scheduled-transaction-loan.service.ts` (the I/O: schedule, overrides, rates, `datedLoanDebts`), `backend/src/scheduled-transactions/scheduled-transactions.controller.ts` (`GET /scheduled-transactions/:id/loan-occurrences`), `backend/src/scheduled-transactions/dto/loan-occurrences-query.dto.ts` (new), `backend/src/i18n/locales/en/errors.json` (only if a new message is needed), their specs.

- The contract, fold, override rules, count bound and missing-data policy of spec section 8, through `priceInstallment` and `bookLoanAllocation`.
- `loan-core-imports.guard.spec.ts` keeps holding the core: the pure fold imports no service.
- Acceptance: every example of spec 8.6; the first occurrence equal to `ScheduledOccurrenceService`'s amount for it and its lines equal to `resolvePostingAllocation` on the same ledger; each row of spec 8.4; `count` 0 and 61 refused by the DTO.
- Inert: nothing calls the read until F2.

### F1 -- Rate-change dialogs

**Files:** `frontend/src/components/accounts/loan-detail/useLoanRateEditing.ts`, `frontend/src/components/accounts/loan-detail/LoanRateControls.tsx`, `frontend/src/components/accounts/loan-detail/RateHistorySidebar.tsx`, `frontend/src/lib/loan-rate-changes.ts`, `frontend/src/types/loan-rate-change.ts`, `frontend/src/i18n/messages/en/accounts.json`, their tests.

- The confirmation already shown after a create is shown after an edit and a delete; it names the installment the proposed figures are for (`dueDate`) and, when `nextPaymentChange` is present, the due date from which the bill becomes that amount.
- After the apply, the scheduled-transaction caches are invalidated (INV-CACHE-001), as the create path's apply does.
- Grep `e2e/` for any accessible name the dialogs change.

### F2 -- Occurrence picker and override editor

**Files:** `frontend/src/components/scheduled-transactions/OccurrenceDatePicker.tsx`, `frontend/src/components/scheduled-transactions/OverrideEditorDialog.tsx`, `frontend/src/lib/scheduled-transactions.ts`, `frontend/src/types/scheduled-transaction.ts`, `frontend/src/i18n/messages/en/scheduledTransactions.json`, their tests.

- For a loan bill (`status: "priced"`), the picker lists each occurrence's `amount` and the editor pre-fills that occurrence's amount and its Principal, Interest and Extra Principal lines (booked at the minor unit, `bookSplitRowsAtMinorUnit`); `complete: false` shows that the amount is unknown and why, never the template's amount in its place. Any other `status` keeps today's per-date behaviour.
- The picker asks for at most 60 occurrences (spec 8.5).

### Q -- Acceptance

**Files:** every locale's catalogs the tasks touched, `docs/system-invariants.md` (INV-LOAN-009 flipped to `enforced` with its tests named; INV-LOAN-006 and INV-OCCURRENCE-003 name the projection), `docs/verification-contract.md` (the row met), the spec's status lines, a release note under `docs/release-notes/` (the stepped payment, the confirmation on edit and delete, that a confirmed sync replaces a raised template with the timeline's figure, and that a template written by the old sync is repaired by confirming a sync).

- Dev data: confirm a sync on the affected dev accounts (BBTest, AAMortgage) and record the before and after template in the PR.

### F3 -- (Later, not approved) Bills calendar and Upcoming Bills

Filed without `approved-to-build`; no work until it is approved.
