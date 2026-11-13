---
title: "Issue #2146: own-rate conversion verified across surfaces, forecast fixed"
author: Node
date: 2026-11-13
branch: claude/issue-2146
cost: { minutes: 26, tokens: 270671 }
touches:
  - docs/system-invariants.md
  - backend/src/ai/forecast/forecast-aggregator.service.spec.ts
  - backend/test/integration/fx-own-rate-surfaces.integration.spec.ts
  - backend/src/ai/forecast/forecast-aggregator.service.ts
---

## Decided
- The list_transactions own-rate fix (byOwnRate / addDatedAmount, 9e56709a0) was already on main; the reporter tested e930711, which predates it. The remaining INV-FX-001/002 gap on an assistant surface was the AI forecast (ai/forecast/forecast-aggregator.service.ts): monthly history and income patterns converted each month at its last day's market rate. Both reads now use splitByRateBasis (byDay) + partRateBasis/convertRateBasis, as the insights aggregator does.
- The income read collects `ARRAY_REMOVE(ARRAY_AGG(DISTINCT t.payeeName), NULL)` and dedups currency+payee in JS, because a per-day split breaks COUNT(DISTINCT). pg returns varchar[] as a JS array (proven on PostgreSQL).
- Balances keep the old today-rate helpers (loadRateIndex/addConverted); per-part reads use marketRateCurrencies/addPart.
- test/integration/fx-own-rate-surfaces.integration.spec.ts is the cross-surface matrix: one month of rows (own-rate expense, market-rate expense, reporting-currency expense, own-rate income) must read EUR 250 / EUR 200 on 13 surfaces (built-in reports, custom report, list_transactions, MCP flow totals, compare_periods, summary, monthly totals, insights, forecast).
- INV-FX-002 is now `partial`: portfolio external flows (securities/external-flow.util.ts and its four folds) ignore a row's own rate. Left as a follow-up because it touches INV-PORTRESULT-001 and a pinned SQL text.

## Tried and ruled out
- Fixed dates for the integration spec: the insights (6 months) and forecast (12 months) windows are relative to today, so the spec uses last month, days 1..28.
- Sharing the rate-basis loop as a new helper in rate-basis-parts.ts: the rule itself is already shared (transactionRateBasis/convertRateBasis); refactoring the other three loops is out of scope.

## Watch out
- backend/node_modules may be missing in a worker: `npm ci --ignore-scripts` is enough for jest and tsc. `npm run typecheck` OOMs at the default heap; use NODE_OPTIONS=--max-old-space-size=4096.
- test:changed needs TEST_CHANGED_BASE set to the branch base when origin/main is not a usable ref; the local `main` was stale.
- Still open, not in scope: getRecurringCharges amounts are unconverted and unlabelled in the forecast/insights prompts, and several budget income/trend sums add currencies without converting.
