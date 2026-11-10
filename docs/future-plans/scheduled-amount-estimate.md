# Plan: estimated scheduled amounts

Executes `docs/specs/scheduled-amount-estimate.md` (issue #2096). Read the spec
first; this plan says what to edit, what to run and what to observe, and
restates the assumptions so a fresh session can pick up any phase.

## Assumptions (verified against the tree, 2026-11-10)

- Every server surface that reports a scheduled occurrence goes through
  `ScheduledOccurrenceService.expand` (INV-OCCURRENCE-003), so pricing an
  estimated occurrence there reaches budgets, reminders, the AI forecast, the
  balance forecast, the occurrences endpoint, the AI assistant and MCP.
- The resolver (`ScheduledEffectiveAmountService`) has one base amount per
  schedule; a per-month estimate therefore cannot live in it and is applied
  per slot after expansion.
- The browser projects the Cash Flow Forecast itself (`frontend/src/lib/forecast.ts`)
  from `GET /scheduled-transactions`, so the list read model carries one
  estimate per month (`amountEstimate.months`) for the client to read.
- The Post dialog, the occurrence editor and the occurrence picker read the
  schedule row they were opened from, not the occurrences endpoint.

## Phase 1 -- schema and backend

Edit: the migration and `database/schema.sql` (`amount_is_estimated`), the
entity and create DTO, `amount-estimate.ts`, `ScheduledAmountEstimateService`
and its module registration, `ScheduledOccurrenceService.expand`,
`ScheduledTransactionsService` (create/update refusals and snapshot, `findAll`,
`post`, the auto-post exclusion, the LLM item, the occurrences read model), the
preview route, the Bill Payment History band, the support-backup rule, the
error catalog.

Run: `npm run lint`, `npm run typecheck`, `npm run migration:lint`,
`TZ=UTC npm run test:changed`. Observe: every guard green; the new specs named
in the spec's section 8 pass.

## Phase 2 -- frontend

Edit: `types/scheduled-transaction.ts`, `lib/scheduled-effective-amount.ts`
(`estimatedOccurrenceAmount`), `lib/forecast.ts`, the forecast tooltip, the
scheduled transaction form (toggle, disabled amount, preview, auto-post), the
Post dialog, the occurrence editor, the occurrence picker, the bills list label,
the `scheduledTransactions` catalog, `website/docs` bills page.

Run: `npm run lint`, `npm run type-check`, `npm run i18n:check`,
`npm run test:changed`. Observe: the forecast projects each month's estimate;
the editor saves an unchanged estimate without an amount.

## Phase 3 -- translations

Every locale's catalog for the new keys, backend and frontend, as the final
commit; `locales.parity.spec.ts` and `messages.parity.test.ts` green.
