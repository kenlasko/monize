# Tasks: mortgage fees

Plan: [`mortgage-fees.md`](./mortgage-fees.md). Spec:
[`docs/specs/mortgage-fees.md`](../specs/mortgage-fees.md).

- [x] Spec, plan and the INV-LOAN-011 entry.
- [x] Migration `loan_fees` + `database/schema.sql` + RLS policy.
- [x] Entity, `priceLoanFee`, fee lines in `identifyLoanTemplate` and `priceInstallment`.
- [x] Template rewrite, posting, projection and rate-change sync answer the bill.
- [x] Backup export, restore and support-backup classification.
- [x] Create mortgage with fees; refuse fees with payment matching.
- [x] `GET`/`PUT /accounts/:id/loan-fees` with the template sync.
- [x] Interest category change refuses a fee's category.
- [x] Frontend: fee editor on create, fees panel on the mortgage detail view.
- [x] Frontend: fee lines in `loanOccurrenceLines`.
- [x] User documentation (`website/docs/accounts.md`, "Mortgage Fees").
- [x] Translate the new catalog entries into every locale.
- [ ] Screenshots of the fee editor and the Mortgage fees panel (`npm run docs:screenshots` in `e2e/`, needs the stack).
- [ ] Settlement of fee-carrying templates by payment matching.
- [ ] A PG integration case for the replace and the posting of a fee-carrying template.
