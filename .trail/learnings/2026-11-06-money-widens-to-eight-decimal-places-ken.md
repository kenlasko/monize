---
title: "Money widens to eight decimal places in storage, but a currency's rounding precision is max(4, its decimal places), so fiat behaves exactly as before"
author: Ken
date: 2026-11-06
branch: claude/crypto-account-currency
id: l-655d5a36
scope: repo
status: active
src: agent
touches:
  - docs/specs/money-precision.md
  - docs/future-plans/money-precision.md
  - backend/src/common/round.util.ts
  - frontend/src/lib/format.ts
---

## Decided

Bitcoin's unit is the satoshi (8 places) and a typical network fee is 0.00001 to 0.0002 BTC, so the four-place money storage rounded every fee to zero or 0.0001. Ken chose per-currency precision up to 8 with storage at 8. The rule: every money column becomes NUMERIC(24,8) (24 keeps the 16 integer digits so no existing value can be rejected); an amount's precision is max(4, currency.decimal_places), so every fiat path keeps the 4 places it has always been stored and rounded at (including sub-cent FX results) and only a coin gains places. roundMoney and sumMoney take the precision with a default of 4, so untouched fiat callers compile and behave unchanged; a write with more places than the currency allows is refused, not rounded, which is what the 4-place DTO cap did for fiat. sumMoney must become exact (BigInt over decimal strings): integer units in doubles pass 2^53 at 8 places for amounts above about 90 million. This supersedes the "four-place limit stands" clause of the coin-as-currency learning.

## Tried and ruled out

- NUMERIC(20,8): drops the integer part to 12 digits and could reject an existing IDR or VND balance.
- Rounding fiat at its own places (2 for CAD): changes stored values and FX results for every existing user; out of scope.
- A per-precision float scale in sumMoney: exact only while amounts stay small.

## Watch out

- The migration lint reads any ALTER COLUMN TYPE as a contract and needs a `-- contract-after: X.Y.Z` marker even for a widening; the grandfather list is shrink-only. A scale change rewrites each table under an access-exclusive lock.
- Subsystems that are fiat by construction (shared expenses at a BigInt scale of 10,000, email receipts, payroll rules, loans, bonds, budgets, reporting figures) keep 4 and get a guard keeping coins out rather than a conversion.

In the code: `docs/specs/money-precision.md`, `docs/future-plans/money-precision.md` (the inventory-based phase list), `backend/src/common/round.util.ts` (`MONEY_SCALE`, `FIAT_MONEY_DECIMALS`, `moneyDecimalsFor`), `frontend/src/lib/format.ts`, migration `*_money_scale_8.sql`.
