# Mortgage types

Design for replacing the two mortgage checkboxes ("Canadian Mortgage",
"Variable Rate") with one **Mortgage type** dropdown, and for adding the two
amortization methods the engine lacks: **linear** (constant principal) and
**interest only**. The task list is
[`mortgage-types-tasks.md`](./mortgage-types-tasks.md). The financial rules,
truth tables and fixtures are in the spec,
[`docs/specs/mortgage-types.md`](../specs/mortgage-types.md); this plan says
what to edit, in what order, and what to run, and defers to the spec on every
number.

Status: **approved** in discussion #1486 (with input from WMP), tracked by
issue #1501. Each task is a sub-issue (#1502 to #1514), one PR each.
All three phases are implemented, through the contract migration (P3-B1).

## 1. Goal

- One **Mortgage type** select on the mortgage form (`MortgageFields.tsx`) and
  the payment setup dialog (`LoanPaymentSetupDialog.tsx`), with help text per
  option saying how to recognise the type from a statement.
- Four types, `ANNUITY` (default), `CANADIAN_FIXED`, `LINEAR`,
  `INTEREST_ONLY`, stored in `accounts.mortgage_type`.
- **Term Length** for every type, as the rate-fixed period; the renewal
  reminder works for all of them.
- A per-account `prepayment_mode` for LINEAR (`SHORTEN_TERM` default,
  `LOWER_INSTALLMENT`).
- A detector that suggests the type from two or three installments and the
  quoted rate, and from ledger history. Suggestion only.
- No existing account's payment, split or EAR changes (spec section 4.2), and the one
  inference change for Canadian variable-rate accounts is named in the release
  note.

## 2. What exists, and what this composes

| Need | Existing piece | Notes |
| --- | --- | --- |
| The two flags | `is_canadian_mortgage`, `is_variable_rate` on `Account` (`backend/src/accounts/entities/account.entity.ts`) | Mutually exclusive conventions presented as independent checkboxes. |
| Periodic rate and EAR | `getPeriodicRate`, `calculateEffectiveAnnualRate` (`backend/src/accounts/mortgage-amortization.util.ts`); `getPeriodicRate` (`frontend/src/lib/loan-frequency.ts`) | Semi-annual only when Canadian and not variable (INV-LOAN-003). |
| Annuity preview | `calculateMortgageAmortization`, `calculateResidualPayoff` (same backend file) | Closed form; INV-LOAN-004. |
| Installment pricing | `ScheduledTransactionLoanService.resolveInstallment` (`backend/src/scheduled-transactions/scheduled-transaction-loan.service.ts`), `allocateLoanPayment` (`backend/src/accounts/loan-payment-waterfall.util.ts`) | INV-LOAN-006: the debt and the rate through the due date. |
| Rate periods | `loan_rate_changes`, `effectiveAnnualRateOn`, `backend/src/accounts/loan-rate-timeline-cases.json` | Rate History in Loan Details. |
| Rate-change recalculation | `buildScheduledUpdate`, `recalculatePaymentForRate`, `syncScheduledTransaction` (`backend/src/loan-rate-changes/loan-rate-changes.service.ts`) | Read `currentBalance` before P1-B3; read `datedLoanDebt` (`backend/src/accounts/dated-loan-debt.util.ts`) since (spec decision 5). |
| Rate inference | `annualizeRate` (`backend/src/loan-rate-changes/rate-change-inference.service.ts`) and its mirror in `frontend/src/lib/loan-history.ts` | Periods-based for Canadian, day count otherwise, before P1-B3 (backend) and P1-F1 (frontend); by `annualizationFor` since. |
| Frontend projection | `generateLoanSchedule` (`frontend/src/lib/loan-schedule.ts`), `buildLoanProjectionInput` (`frontend/src/lib/loan-history.ts`) | Annuity row by row, with re-levelling and the stall rescue. |
| Setup payments | `LoanPaymentSetupService` (`backend/src/accounts/loan-payment-setup.service.ts`), `backend/src/accounts/dto/setup-loan-payments.dto.ts` | |
| Account create and preview | `LoanMortgageAccountService` (`backend/src/accounts/loan-mortgage-account.service.ts`), `backend/src/accounts/dto/create-account.dto.ts`, `backend/src/accounts/dto/update-account.dto.ts`, `backend/src/accounts/dto/mortgage-preview.dto.ts` | |
| Renewal reminder | `backend/src/accounts/mortgage-reminder.service.ts` | Reads `term_end_date` only; type-agnostic already. |
| Flag consumers outside accounts | `backend/src/action-history/action-history.service.ts`, `backend/src/backup/support-backup/support-backup-rules.ts`, `backend/src/database/demo-seed.service.ts`, `backend/src/database/demo-seed-data/accounts.ts`, `LlmAccountRow` (`backend/src/accounts/accounts.service.ts`) | Every one of them moves to the type. |
| Frontend flag consumers | `frontend/src/types/account.ts`, `frontend/src/components/accounts/AccountForm.tsx` (`optionalEnum`), `frontend/src/lib/loan-schedule-types.ts`, `frontend/src/lib/loan-frequency.ts`, `frontend/src/lib/loan-figures.ts`, `frontend/src/lib/loan-past-impact.ts`, `frontend/src/components/accounts/loan-detail/LoanSummaryCards.tsx`, `frontend/src/components/import/CompleteStep.tsx` | Located by `git grep isCanadianMortgage`; re-run it at the start of P1-F1. |
| Guard models | `backend/src/accounts/mortgage-frequency-cast.guard.spec.ts` (shrink-only caller scan), `backend/src/common/db/rls-exempt-tables.spec.ts` (constant reconciled with `database/schema.sql`) | |

## 3. Decisions

The eleven decisions are in spec section 3. The ones that decide the shape of the
work:

1. The column is nullable in Phase 1 and read through `mortgageTypeFromFlags`
   when null; Phase 3 makes it `NOT NULL DEFAULT 'ANNUITY'` and drops the
   booleans (expand now, contract later, `database/CLAUDE.md`).
2. Traits are written once per layer (`MORTGAGE_TYPE_TRAITS`) and consumers
   branch on a trait. Parity between the layers is a shared JSON fixture.
3. The boolean overloads of `getPeriodicRate` and
   `calculateEffectiveAnnualRate` delegate to the type-keyed functions during
   Phase 1 and 2, held by a shrink-only guard, and are deleted in Phase 3.
4. The new methods compute at storage precision (`roundMoney`, 4dp), like the
   annuity engine (spec decision 7).
5. An INTEREST_ONLY template keeps its principal line, at 0 (spec section 9).
6. `accounts.payment_amount` is null for LINEAR and INTEREST_ONLY; every
   surface asks for a dated installment instead (spec decision 11 and
   section 5.6, which lists every reader and the task that changes it).

## 4. Phases

| Phase | Tasks | What ships | Behaviour change |
| --- | --- | --- | --- |
| 0 | S1 | This plan and the spec | none |
| 1 | P1-B1 to P1-Q | The column, the type-keyed math, the dropdown with two working values (`ANNUITY`, `CANADIAN_FIXED`), Term Length for every type, dated debt on the rate-change path, copy fixes | Canadian variable-rate inference moves to day count; a future-dated rate change prices the debt at its date |
| 2 | P2-B1 to P2-Q | `LINEAR` and `INTEREST_ONLY` on both layers, `prepayment_mode`, the detector | New types selectable |
| 3 | P3-B1 | `NOT NULL DEFAULT 'ANNUITY'`, the booleans dropped, overloads and guard deleted | none |

Phase 1 offers only `ANNUITY` and `CANADIAN_FIXED` in the select; the DTOs
refuse `LINEAR` and `INTEREST_ONLY` until P2-B1 (the CHECK accepts all four
from P1-B1, so no second migration is needed to widen it). P3-B1 waits one
release after Phase 1 shipped, so a rollback to the previous image still finds
the booleans it reads.

## 5. Where each rule is held

| Rule | Mechanism | Task |
| --- | --- | --- |
| The database accepts only the four types | CHECK on `accounts.mortgage_type`, reconciled with `MORTGAGE_TYPES` by a contract spec in both directions | P1-B1, P1-B2 |
| `prepayment_mode` only on LINEAR | CHECK `prepayment_mode IS NULL OR mortgage_type = 'LINEAR'`; the service writes null for other types | P2-B1 |
| One method per type (INV-LOAN-007) | `MORTGAGE_TYPE_TRAITS` per layer, `mortgage-type-cases.json` parity, the method branch on each surface | P1-B2, P1-F1, P2-B1, P2-F1 |
| A stored type never disagrees with the flags | from P1-B1, a save that changes either flag cleared the type (a helper P1-B3 removed), so the reader falls back to the flags; from P1-B3, every writer stores the type and the flags it maps to together (`mortgageTypeColumns`), and every reader goes through `mortgageTypeOf` | P1-B1, P1-B3 |
| No new boolean caller | shrink-only flags guard (`mortgage-type-flags.guard.spec.ts`) | P1-B2, deleted in P3-B1 |
| Dated debt on a rate change | `datedLoanDebt` (`backend/src/accounts/dated-loan-debt.util.ts`) called from both rate-change paths and the mortgage rate update | P1-B3 |
| Every figure matches the spec | fixtures copied from spec section 7 | P2-B1, P2-F1 |
| No stored constant payment for LINEAR or INTEREST_ONLY | CHECK on `accounts.payment_amount`; every reader in spec table 5.6 asks for a dated installment | P2-B1, P2-F1 |

## 6. Assumptions, restated for a fresh session

- The spec's section 7 tables are the fixtures; they were produced by an
  independent period-by-period loop, not by the implementation.
- `amortization_months` is the full amortization for every type, and the
  INTEREST_ONLY bullet date. `term_months` / `term_end_date` are the
  rate-fixed period and drive only the renewal reminder.
- `LOAN` accounts are untouched: no type, no new methods.
- The loan payment's pricing path stays one function (`resolveInstallment`);
  the new methods are a branch inside it, not a second service.
- Locales: English first in each task, `npm run i18n:pseudo` after editing
  `en/*`; the full-locale pass is P1-Q for Phase 1 strings and P2-Q for
  Phase 2 strings.

## 7. Risks

| Risk | Mitigation |
| --- | --- |
| A consumer keeps reading the booleans and disagrees with the type after a save | `flagsFromMortgageType` writes both columns on every save in Phases 1 and 2; the flags guard names every remaining reader |
| A rollback after P3-B1 finds no booleans | P3-B1 waits one release after Phase 1 (section 4) |
| A surface shows the first installment as "the payment" of a LINEAR mortgage long after it fell | `payment_amount` is null for these methods (spec decision 11) and spec table 5.6 assigns every reader to P2-B1 or P2-F1 |
| A LINEAR installment grows after a rate rise and the posting refuses to grow the parent | spec 5.2: the confirmed sync and template advancement target the method installment; P2-B1 tests the sequence |
| A residue payment of a fraction of a cent after the last LINEAR installment | spec decision 8, asserted by the 7.1 fixture |
| An E2E spec drives the old checkboxes | P1-F2 greps `e2e/` for the old accessible names |
