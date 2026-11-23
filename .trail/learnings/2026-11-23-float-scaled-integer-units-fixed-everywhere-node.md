---
title: "Float-scaled integer units fixed everywhere and guarded in both layers (#2346 round 2)"
author: Node
date: 2026-11-23
branch: claude/issue-2346
cost: { minutes: 42, tokens: 371736 }
touches:
  - backend/src/accounts/loan-payment-waterfall.util.ts
  - backend/src/common/money-units.guard.spec.ts
  - backend/src/import/kmy/map/kmy-file-summary.ts
  - backend/src/import/mny/mny-parser.service.spec.ts
  - backend/src/import/mny/mny-parser.service.ts
  - backend/src/loan-installments/plan-loan-settlement.ts
  - backend/src/loan-installments/project-loan-occurrences.ts
  - backend/src/net-worth/invested-period-result.util.spec.ts
  - backend/src/net-worth/invested-period-result.util.ts
  - frontend/src/lib/chart-buckets.test.ts
---

## Decided
- Ken asked to fix the same bug everywhere, not only FxAggregate, so the earlier "left for a follow-up" note no longer holds. Every money and share site that did `Math.round(x * 10000)`, `* 1e8`, `* 10 ** places` or `* scaleOf(key)` now uses the exact helpers in `backend/src/common/round.util.ts`: `moneyUnits(x, decimals)` (new: a number of units, rounded like roundToDecimals, then shifted by digits), `sumMoney`, `roundMoney` / `roundToDecimals`, or `toScaledUnits` / `fromScaledUnits` for a BigInt total. On the client: `sumMoney`, `roundMoney`, `toMoneyUnits` / `fromMoneyUnits`.
- Guards: `backend/src/common/money-units.guard.spec.ts` and `frontend/src/test/money-units.guard.test.ts` (TypeScript AST) fail a `Math.round` of a product with a scale. A `... / 100` percentage is exempt. Both baselines are empty.
- Scale legs before netting: `minor(in) - minor(out)`, never `minor(in - out)`. The float subtraction alone can lose a unit.

## Tried and ruled out
- Lowercase `scale` names in the frontend guard: image and PDF pixel scaling uses them (document-scanner, pdf-export-charts). The frontend matches only constant names; the backend matches case-insensitively.
- Changing `quantityFromTotal` in `frontend/src/lib/investmentFold.ts`: `investmentFold.guard.test.ts` pins its `100_000_000` literal as a fingerprint, and the quantity it rounds is never negative. Left as is, and the frontend guard skips 1e8.

## Watch out
- The layer `CLAUDE.md` files are within about 40 bytes of their ceiling, and AGENTS.md is at 26607 of 26624. A new rule goes in `docs/financial-semantics.md` section 4.
- `simplefin.foundation.spec.ts` fails 3 window tests when TZ is America/Toronto, even on main. Run it with TZ=UTC.
- Backend `toScaledUnits` throws on NaN. Guard a value that is not known to be finite (`moneyUnits` passes non-finite values through).
