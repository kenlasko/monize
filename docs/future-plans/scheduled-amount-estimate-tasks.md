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

- [x] Types and `estimatedOccurrenceAmount`; `lib/scheduled-effective-amount.test.ts`.
- [x] `lib/forecast.ts` per-month estimate and the tooltip label; `lib/forecast.test.ts`.
- [x] Form toggle, disabled amount, preview, auto-post; `ScheduledTransactionForm.test.tsx`.
- [x] Post dialog prefill; `PostTransactionDialog.test.tsx`.
- [x] Occurrence editor prefill and unchanged-save; `OverrideEditorDialog.test.tsx`.
- [x] Occurrence picker per-month estimate and badge; bills list label;
      `OccurrenceDatePicker.test.tsx`, `ScheduledTransactionList.test.tsx`,
      `CashFlowForecastChart.test.tsx`.
- [x] `website/docs` bills page; `docs/frontend/financial-figures.md`;
      INV-OCCURRENCE-004 in the catalog and the verification matrix.
- [ ] Screenshots of the changed screens (`npm run docs:screenshots` in `e2e/`).

## Phase 3 -- translations

- [x] Every locale, backend and frontend, as the final commit.
