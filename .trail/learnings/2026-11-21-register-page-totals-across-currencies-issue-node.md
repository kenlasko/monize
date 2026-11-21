---
title: "Register page totals across currencies (issue #2308)"
author: Node
date: 2026-11-21
branch: claude/issue-2308
cost: { minutes: 9, tokens: 96214 }
touches:
  - frontend/src/components/transactions/TransactionList.tsx
  - frontend/src/components/transactions/TransactionList.uiStyles.test.tsx
  - frontend/src/components/transactions/register-style-data.test.ts
  - frontend/src/components/transactions/register-style-data.ts
  - frontend/src/components/transactions/variants/PebbleRegister.tsx
  - frontend/src/i18n/messages/en/transactions.json
  - frontend/src/i18n/messages/xx/transactions.json
  - frontend/src/lib/currency-total.ts
---

## Decided
- `pageTotals` (Folio footer) and `netByDate` (Folio/Pebble day nets) in `frontend/src/components/transactions/register-style-data.ts` share the same defect: they summed rows of every currency and labelled the sum with the first row's currency. Both were fixed together.
- Committed approach (pending the maintainer's answer on #2308): sum in the rows' shared currency; on a mixed page convert each row into the default currency via `useExchangeRates().convert` and `sumConverted` (now with an optional `decimals`), and render through `PartialTotal`.

## Tried and ruled out
- Nothing rejected yet, but the #2106 learning says the maintainer chose server-side conversion and rejected client `useExchangeRates` conversion, so the client-side version may be replaced by option B (server per-row converted amount) or C (withhold mixed-page figures).

## Watch out
- Regular `Transaction` rows carry no `reportingRate` / `ratesInto`; only investment rows do (`convertRowAmount`). A server-converted register total needs a backend change.
- `npm run type-check` aborts out of heap here; `NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit` works. `test:changed` takes no args.
