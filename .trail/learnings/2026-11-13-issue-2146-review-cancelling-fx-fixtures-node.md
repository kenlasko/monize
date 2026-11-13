---
title: "Issue #2146 review: cancelling FX fixtures, and portfolio flows are exempt from INV-FX-002"
author: Node
date: 2026-11-13
branch: claude/issue-2146
cost: { minutes: 6, tokens: 67193 }
touches:
  - docs/system-invariants.md
  - backend/src/ai/forecast/forecast-aggregator.service.spec.ts
  - backend/test/integration/fx-own-rate-surfaces.integration.spec.ts
  - docs/specs/portfolio-period-result.md
---

## Decided
- Correction to the earlier #2146 learning: INV-FX-002 stays `enforced`, with a Scope line. The portfolio period result's external flows and invested capital (securities/external-flow.util.ts and its folds, net-worth/invested-capital-flow.util.ts) convert at the market rate on their day by design (docs/specs/portfolio-period-result.md sections 2 and 10.2, case 11). Each is subtracted from a value change that values the same cash or shares at that day's market rate, so the own rate would book the conversion spread as an investment result.
- The cross-surface spec's fixture is USD 132 at 1.20 beside USD 125 at its own 1.25, so every wrong reader has its own number: own rate ignored 266.38, month-end rate 262.34, both 268.72, right 260. The docblock lists them.

## Tried and ruled out
- USD 110 at 1.10 beside USD 125 at its own 1.25 with a month-end 1.175: (110 + 125) / 1.175 is exactly the right EUR 200, so a reader making both mistakes passed every expense assertion and the pre-#2130 insights code passed the spec.

## Watch out
- An FX fixture with two foreign rows can cancel the two errors it is meant to catch. Compute each wrong reading (own rate ignored, month-end or latest rate, both) and check they all differ from the expected figure before trusting the expense assertions. Then break the code on purpose (swap in the old file from git) and confirm the spec fails.
- A unit case dated on the month's last day, beside the only rate, cannot tell "the row's own day" from "the month end".
