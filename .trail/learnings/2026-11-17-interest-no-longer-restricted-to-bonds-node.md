---
title: "Interest no longer restricted to bonds (issue #2257)"
author: Node
date: 2026-11-17
branch: claude/issue-2257
cost: { minutes: 23, tokens: 215568 }
touches:
  - backend/src/i18n/locales/de/errors.json
  - backend/src/i18n/locales/en/errors.json
  - backend/src/i18n/locales/es/errors.json
  - backend/src/i18n/locales/fr/errors.json
  - backend/src/i18n/locales/hi/errors.json
  - backend/src/i18n/locales/id/errors.json
  - backend/src/i18n/locales/it/errors.json
  - backend/src/i18n/locales/ja/errors.json
  - backend/src/i18n/locales/ko/errors.json
  - backend/src/i18n/locales/nl/errors.json
---

## Decided
INV-INTEREST-001 ("interest paid on a bond is stored on that bond") was
narrowed to a bond-only picker on purpose when #2112 added it. Issue #2257
asked for it to apply to any security type, so the restriction was removed
entirely rather than widened to an allowlist: `assertInterestSecurityIsBond`
(backend/src/securities/investment-transactions.service.ts) deleted along
with its two call sites in `create`/`update`, and the frontend's
`securityType === 'BOND'` filter plus the useEffect that cleared a non-bond
security when switching an action to Interest
(frontend/src/components/investments/InvestmentTransactionForm.tsx) removed.
The `errors.securities.interestSecurityMustBeBond` key was deleted from all
19 backend locales + xx (same line number in every file, safe to sed).
Frontend's `selectBondOptional` i18n key renamed to `selectSecurityOptional`
across all locales + regenerated xx pseudo-locale.

## Tried and ruled out
Kept the useEffect but changed its predicate to also accept non-bond types:
unnecessary, since removing the restriction means there's nothing left to
clear for -- the effect existed solely to enforce the bond-only rule.

## Watch out
Picking a non-bond security whose currency differs from the brokerage
account's cash currency now needs an exchange rate (same as Dividend
already did) -- this was previously masked in the "Dividon-to-Interest"
switch test because the old effect auto-cleared the non-bond security
before submit, so no FX was ever involved. Tests that keep a
cross-currency security through an Interest switch must mock a market
rate (see InvestmentTransactionForm.test.tsx, 'AAPL is USD against the
CAD brokerage account').
