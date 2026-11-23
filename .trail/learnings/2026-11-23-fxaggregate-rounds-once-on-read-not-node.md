---
title: "FxAggregate rounds once on read, not per component (issue 2360)"
author: Node
date: 2026-11-23
branch: claude/issue-2360
cost: { minutes: 25, tokens: 145054 }
touches:
  - backend/src/built-in-reports/income-reports.service.spec.ts
  - backend/src/common/fx-aggregate.spec.ts
  - backend/src/common/fx-aggregate.ts
  - backend/src/reports/reports.service.spec.ts
  - docs/specs/fx-conversion-completeness.md
  - frontend/src/lib/currency-total.ts
---

## Decided
- FxAggregate accumulates each component at 12 places (FIAT_MONEY_DECIMALS + 8) in a BigInt and rounds to 4 only when knownSubtotal/total is read. This makes "convert each row, then sum" (Custom Report via report-net-cells) agree with "sum the rows, then convert" (Income by Source, other built-in reports grouping by rate basis). Example: 2 x 100.01 EUR at 1.2474 = 249.5049 USD on both.
- The read goes through roundMoney(fromScaledUnits(units, 12), 4), so a lone component reads exactly as roundMoney answers it.
- Fixed at the accumulator rather than in the Custom Report, because Income by Source itself also rounded per (category, currency, date) part, so two receipts on two days gave 249.5050 there too.

## Tried and ruled out
- Rounding the 12-place units to 4 in integers (half away from zero): it reads a float artefact just under a midpoint (41919.852249999996) down, where roundMoney's one-ULP nudge reads it up. A fuzz over 200,000 values found 5,132 mismatches; through roundMoney there are 0.
- Making the Custom Report sum native amounts per rate basis before converting: it matches Income by Source only while both round per date part, so the per-component rounding stays.

## Watch out
- The client's sumConverted (frontend/src/lib/currency-total.ts) still sums through sumMoney, which rounds each converted component to 4 places, so a client-side total of converted rows can still differ by 0.0001 from the server's.
- 360 related backend specs passed unchanged: no existing fixture depended on per-component rounding.
