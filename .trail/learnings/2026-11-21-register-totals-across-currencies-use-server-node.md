---
title: "Register totals across currencies use server-stamped reportingRate (issue #2308)"
author: Node
date: 2026-11-21
branch: claude/issue-2308
cost: { minutes: 21, tokens: 118597 }
touches:
  - docs/system-invariants.md
  - frontend/src/components/transactions/TransactionList.tsx
  - frontend/src/components/transactions/TransactionList.uiStyles.test.tsx
  - frontend/src/components/transactions/register-style-data.test.ts
  - frontend/src/components/transactions/register-style-data.ts
  - frontend/src/components/transactions/variants/PebbleRegister.tsx
  - frontend/src/i18n/messages/en/transactions.json
  - frontend/src/i18n/messages/xx/transactions.json
  - frontend/src/lib/currency-total.ts
  - frontend/src/types/transaction.ts
---

## Decided
- The maintainer chose option B on #2308: GET /transactions and findRegisterRowsByIds stamp `reportingCurrencyCode` / `reportingRate` on every register row (`backend/src/transactions/register-reporting-rates.ts`), by `transactionRateBasis` + `convertRateBasis`, with the reader's own transfer legs read through `transferRateSql` gated by `ownTransferLegs`.
- The Folio footer (`pageTotals`) and the Folio/Pebble day nets (`netByDate`) sum in the rows' shared currency, else in the reporting currency at `amount * reportingRate`; a row without a factor for that currency is excluded and shown through `PartialTotal`.
- `sumConverted` now passes the item as a third argument to `convert`, and takes an optional `decimals`.

## Tried and ruled out
- Client-side conversion with `useExchangeRates().convert` (the first commit on the branch): it converts at today's rate, against INV-FX-002 and the #2106 decision. It was replaced.

## Watch out
- A surface that renders `TransactionList` from an endpoint that does not stamp `reportingRate` shows a mixed page as partial, never as a face-value sum.
- One integration spec runs against a throwaway `postgres:18-alpine` with `DATABASE_PORT=<port> npx jest --config ./test/jest-integration.json --runInBand <file>`; the defaults (`monize_user` / `monize_password` / `monize_test`) need no other env.
