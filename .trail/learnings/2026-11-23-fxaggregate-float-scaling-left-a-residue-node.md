---
title: "FxAggregate float scaling left a residue on large cancelling amounts (#2346)"
author: Node
date: 2026-11-23
branch: claude/issue-2346
cost: { minutes: 22, tokens: 164985 }
touches:
  - backend/src/common/fx-aggregate.spec.ts
  - backend/src/common/fx-aggregate.ts
  - backend/src/common/round.util.ts
  - backend/src/net-worth/period-flow-fold.util.spec.ts
  - docs/specs/fx-conversion-completeness.md
---

## Decided
- FxAggregate scales each component with `toScaledUnits(roundMoney(x, 4), 4)` (exact decimal shift) into a `bigint` subtotal, read back with `fromScaledUnits`. Both helpers are exported from `backend/src/common/round.util.ts`; sumMoney and roundToDecimals use `fromScaledUnits` too.
- Kept `roundMoney` before the shift so #2136's midpoint behaviour (the one-ULP nudge) is unchanged; `toScaledUnits` alone rounds a float-artefact `...4999999` down.
- Non-finite components keep their old meaning (NaN/Infinity read through `total`/`knownSubtotal`) via a separate `nonFiniteSum` number; the policy was left for its own proposal.

## Tried and ruled out
- Treating NaN/Infinity as `addUnknown()`: consumers such as net-worth's monthly `fxComplete` read `missingPairs.length`, not `isComplete`, so a dropped component showed up as a smaller "complete" figure.
- A float fast path (`Math.round(rounded * 10000)` below ~2^50 units): provably exact but it is the per-precision float scale money-precision decision 4 rejected. Measured cost of the exact path is ~6us vs ~3.5us per add under jest.

## Watch out
- `convertAtDate` returns the raw `amount * rate`, so a fold test needs a non-unit rate (0.8 on 400000000000.07) to exercise the converted path.
- About 15 other sites still hand-roll `Math.round(x * 10000)` accumulation with the same defect (invested-period-result.util.ts, investment-transactions.service.ts gains totals, loan-fees.service.ts, loan-rate-changes, daily-movement, portfolio.service intraday, notification-center portfolio-flow.util.ts, frontend chart-buckets/look-through-allocation/shared-split-editor). Reported as a follow-up, not fixed in #2346.
- node_modules is not installed in a fresh worktree: `npm ci` in backend/ first (~20s).
