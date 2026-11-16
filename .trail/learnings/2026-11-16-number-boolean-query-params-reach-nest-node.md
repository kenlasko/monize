---
title: "Number/boolean query params reach Nest's converters as raw text (#2225)"
author: Node
date: 2026-11-16
branch: claude/issue-2225
cost: { minutes: 34, tokens: 271897 }
touches:
  - frontend/src/i18n/messages/de/investments.json
  - frontend/src/i18n/messages/es/investments.json
  - frontend/src/i18n/messages/fr/investments.json
  - frontend/src/i18n/messages/hi/investments.json
  - frontend/src/i18n/messages/id/investments.json
  - frontend/src/i18n/messages/it/investments.json
  - frontend/src/i18n/messages/ja/investments.json
  - frontend/src/i18n/messages/ko/investments.json
  - frontend/src/i18n/messages/nl/investments.json
  - frontend/src/i18n/messages/pl/investments.json
---

## Decided
- `createGlobalValidationPipe` (backend/src/common/pipes/global-validation.pipe.ts) returns a `GlobalValidationPipe` subclass overriding the protected `transformPrimitive`: a named @Query/@Param emitted as Number or Boolean is passed through as sent, "" as undefined (like ParseOptionalCalendarDatePipe). Nest's ParseIntPipe/ParseFloatPipe/ParseBoolPipe then check the real text: `?limit=0x10`, `?includeInactive=yes` and repeated keys are 400, `?limit=` takes the DefaultValuePipe default.
- `global-validation-param-pipes.guard.spec.ts` now requires every Number/Boolean query/param to END with its type's converter, after at most a DefaultValuePipe (all 28 existing ones already did). A pipe of ours checks text and sits on a `string` parameter.
- `global-validation-pipe-registration.guard.spec.ts`: every `useGlobalPipes(` in src/ and test/ is `createGlobalValidationPipe()` alone.
- `BondHoldingsService.redemptionSplit` refuses a quantity outside 1..MAX_REDEMPTION_QUANTITY with `quantityInvalidException` (errorCode QUANTITY_INVALID, shared with ParseBondQuantityPipe); the frontend mirrors MAX_REDEMPTION_QUANTITY in useBondRedemptionSplit.ts, checked by bond-query.pipes.spec.ts.

## Tried and ruled out
- Strict number conversion inside the global pipe: it can't know int vs float, so `2.9999999999999999` would still reach ParseIntPipe as 3.
- Per-route custom pipes on `string` params for all 28: many touch points, and the trap would stay for the next number param.

## Watch out
- An imported `type X = number` emits `Object` under Jest's isolatedModules transpile but `Number` under `nest build`, so the guard can't see it. Declare `number`/`boolean` directly.
- ParseIntPipe on raw text accepts 22+ digit integers (1e21) that `+value` used to refuse; int params are unbounded (scheduled `days` 1e8 gives a NaN date, `priceId` gives a DB error). Bound them in a follow-up.
- Converter 400s are Nest's untranslated English ("Validation failed (boolean string is expected)").
- test/payee-detail and category-detail e2e specs fail at module compile (DelegationService needs I18nService); that has nothing to do with the pipe.
- `loan-payment-frequency.guard.spec.ts` needs UTC-midnight Dates (`new Date("YYYY-MM-DD")` + formatDateYMD), as advancePaymentDates documents.
