# Tasks: estimated scheduled amounts

Task list for `docs/future-plans/scheduled-amount-estimate.md`. Check a box only
when its gate passes and is quoted in the commit or PR.

## Phase 1 -- schema and backend

- [x] Migration `amount_is_estimated` + `database/schema.sql` + support-backup rule.
- [x] Entity, DTO, `amount-estimate.ts`, `ScheduledAmountEstimateService`, module.
- [x] Per-month pricing in `ScheduledOccurrenceService.expand`; outflow candidate read.
- [x] Create/update refusals and snapshot, `findAll` read model, posting default,
      auto-post exclusion, LLM `amountEstimated`, occurrences `estimated`.
- [x] Preview route `GET /scheduled-transactions/amount-estimate/:accountId`.
- [x] Bill Payment History band skipped for an estimated bill.
- [x] Specs: `amount-estimate.spec.ts`, `scheduled-amount-estimate.service.spec.ts`,
      the "an estimated schedule" and "estimated amounts" blocks, the report and
      controller cases.

## Phase 2 -- frontend

- [ ] Types and `estimatedOccurrenceAmount`; `lib/scheduled-effective-amount.test.ts`.
- [ ] `lib/forecast.ts` per-month estimate and the tooltip label; `lib/forecast.test.ts`.
- [ ] Form toggle, disabled amount, preview, auto-post; `ScheduledTransactionForm.test.tsx`.
- [ ] Post dialog prefill; `PostTransactionDialog.test.tsx`.
- [ ] Occurrence editor prefill and unchanged-save; `OverrideEditorDialog.test.tsx`.
- [ ] Occurrence picker badge; bills list label.
- [ ] `website/docs` bills page.

## Phase 3 -- translations

- [ ] Every locale, backend and frontend, as the final commit.
