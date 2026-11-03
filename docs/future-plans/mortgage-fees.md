# Plan: mortgage fees

Executes [`docs/specs/mortgage-fees.md`](../specs/mortgage-fees.md); read the
spec first. This plan says what to edit, what to run and what to observe. The
task list is [`mortgage-fees-tasks.md`](./mortgage-fees-tasks.md).

## Assumptions (verified against the tree, 2026-11-03)

- A mortgage's payment is the schedule `accounts.scheduled_transaction_id`
  points at; its template is a principal transfer, an interest line on
  `accounts.interest_category_id`, and optionally an extra-principal transfer.
  Any other line makes `identifyLoanTemplate`
  (`backend/src/loan-installments/price-installment.ts`) report it unmanaged,
  and every pricing purpose then declines.
- Every consumer prices through `priceInstallment` (the template rewrite in
  `reprice-template.ts`, the posting in
  `ScheduledTransactionLoanService.resolvePostingAllocation`, the projection in
  `project-loan-occurrences.ts`, the settlement planner), so the loan portion
  is the one place to subtract the fee lines.
- The posting path re-sums the parent from the payload's lines after applying
  `amountsBySplitId` (`ScheduledTransactionsService.post`), so a fee line the
  allocation leaves at its stored amount is carried into the parent.
- `loan_rate_changes` and `payroll_deduction_rules` are the patterns for a
  user-owned child table: direct RLS policy, backup export, restore wipe,
  restore plan, references and the support-backup rules.

## Phase 1: schema and engine (backend)

- Migration `*_loan_fees.sql` and `database/schema.sql`: the table, its
  indexes, the `updated_at` trigger, RLS enable and policy, and the
  `direct_tables` entry.
- `backend/src/loan-installments/loan-fees.ts`: `LoanFeeTerms` and the pure
  `priceLoanFee`; `backend/src/loan-fees/entities/loan-fee.entity.ts`.
- `price-installment.ts`: `identifyLoanTemplate` takes the fees; the core
  reads them; `priceInstallment` prices the loan portion and the fee lines.
- `reprice-template.ts`, `scheduled-transaction-loan.service.ts`,
  `project-loan-occurrences.ts`, `loan-rate-changes.service.ts`: write and
  answer the bill.
- Backup: export query, wipe, plan, references, support-backup rules and
  integrity, `backup-format.ts`.
- Run: `npm run lint && npx tsc --noEmit && npm run typecheck`,
  `npm run test:unit -- loan-installments loan-fees scheduled-transaction-loan`,
  `npm run migration:lint`.

## Phase 2: writing fees (backend)

- `CreateAccountDto.loanFees`, `LoanFeeDto`; `createMortgageAccount` writes the
  fee lines; refuses fees with payment matching. The shared checks are
  `backend/src/loan-fees/loan-fee-terms.ts`.
- `LoanFeesService.replace` and `GET`/`PUT /accounts/:id/loan-fees`
  (`backend/src/loan-fees/`).
- `planLoanInterestRelink` refuses a fee's category.
- English catalog entries, `npm run i18n:pseudo`.

## Phase 3: frontend

- `frontend/src/types/loan-fee.ts`, `frontend/src/lib/loan-fees.ts` (API
  client and the editor's drafts; the per-installment figure is the
  server's alone).
- `LoanFeesEditor` (the rows), used by `MortgageFields` on create and by
  `LoanFeesPanel` in the mortgage's detail view.
- `frontend/src/lib/loan-occurrence.ts`: fee line roles.
- Run: `npm run lint && npm run type-check && npm run i18n:check`,
  `npm run test -- loan-fee loan-occurrence MortgageFields`.

- `website/docs/accounts.md`, "Mortgage Fees"; every locale translated.

## Phase 4 (follow-up, not in this PR)

- Settlement of a fee-carrying template by payment matching (spec section 8).

## What should be observed

- A new mortgage with a 50.00 fixed fee and a 0.5 % annual fee on the current
  balance of 400,000 shows a first bill of P&I + 50.00 + 166.67, with two
  extra lines carrying the chosen categories.
- After the first posting, the next bill's balance fee is priced on the lower
  debt; the fixed fee is unchanged.
- Removing a fee in the loan detail panel removes its line and lowers the next
  bill by exactly that line.
