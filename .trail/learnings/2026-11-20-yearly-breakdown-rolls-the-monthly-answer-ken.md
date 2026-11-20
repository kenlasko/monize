---
title: "Yearly breakdown rolls the monthly answer up on the client, and yearly presets count calendar years"
author: Ken
date: 2026-11-20
branch: feat/breakdown-yearly-view
cost: { minutes: 1, tokens: 1858 }
id: l-7bfedaf0
scope: repo
status: active
src: agent
touches:
  - frontend/src/lib/breakdown-period.ts
  - frontend/src/lib/monthly-funds-summary.ts
  - frontend/src/components/reports/MonthlyCategoryBreakdownReport.tsx
---

## Decided
- The Monthly & Yearly Breakdown's yearly view is built on the client from the server's monthly answer: each row's month figures (already converted into the reporting currency per month) are summed per year with sumMoney. No backend parameter, no second query; a year cell equals the sum of the month cells it replaces. The tagged Balance block does the same with the Income vs Expenses monthly periods (a year is known when the answer covers any of its months).
- Field names stay the server's (`months`, `valuesByMonth`) and hold `YYYY` keys in yearly mode, so the one table model draws both widths.
- Storage keys keep the old `monthly-category-breakdown` prefix so readers' choices survive the rename; the yearly window and "Include current year" have keys of their own.
## Tried and ruled out
- Snapping the resolved 2y/5y/10y preset start to 1 January: the 2y preset is a 730-day lookback, and on 31 December of a leap year that lands on 1 January of the following year, giving one whole year instead of two. `yearlyWindowStart` counts N calendar years back from the current year instead.
## Watch out
- A persisted sort on a month column (`2025-03`) matches nothing in a yearly table; switching width resets the sort to the category name.
- Drill-downs end at the window's end (`columnRange`), so the current year or month opens only up to the window's last day, and a custom window ending mid-column opens only what the cell counted.

In the code: frontend/src/lib/breakdown-period.ts, frontend/src/lib/monthly-funds-summary.ts, frontend/src/components/reports/MonthlyCategoryBreakdownReport.tsx
