---
title: "Issue #2130: one conversion rule and one read for the #2107 leftovers"
author: Node
date: 2026-11-12
branch: claude/issue-2130
cost: { minutes: 90, tokens: 640515 }
touches:
  - backend/src/built-in-reports/rate-basis-parts.spec.ts
  - backend/src/built-in-reports/rate-basis-parts.ts
  - backend/src/reports/dto/execute-report.dto.ts
  - backend/src/reports/report-net-cells.spec.ts
  - backend/src/reports/report-net-cells.ts
  - backend/src/reports/reports.service.spec.ts
  - backend/src/reports/reports.service.ts
  - backend/src/securities/portfolio-calculation.service.spec.ts
  - backend/src/securities/portfolio-calculation.service.ts
  - docs/system-invariants.md
---

## Decided
- The assistant's analytics (list/query totals, breakdowns, comparisons, monthly totals) read a row's own rate through `partRateBasis` + `convertRateBasis`, the reports' rule; `byOwnRate` is `splitByRateBasis(..., { byDay: false })`.
- `built-in-reports/rate-basis-parts.ts` is the one-read pattern: `splitByRateBasis` adds `fx_day` / `fx_original_currency` / `fx_exchange_rate` (CASE-gated on the reporting currency, so reporting rows stay one part), `foldRateParts` folds the parts back for native sums, and `convertRateParts` converts the same parts. The transaction summary, grouped totals, tag breakdown and category/payee detail account panels use it instead of a second read.
- The grouped totals keep their SQL bound with `readTopGroupParts`: a CTE over the split read, keeping the parts of the top `limit` groups by summed magnitude, ties broken `group_key COLLATE "C"`.
- The capital-gains fold keeps a reporting-currency set of flows in the same pass over calculateRealizedGains' reporting replay. A sale's gain comes from `disposalInReporting` (securities/disposal-in-reporting.ts), shared with Realized Gains, so the two agree. Use the reporting fold for every group when any account is foreign, as Realized Gains does; mirroring account figures for same-currency groups broke agreement on legacy stored-1 rows.
- A custom-report cell is split per currency, and a money figure drops a part whole when any of its lines lacks a rate. Each dropped converted unit is recorded once via `gaps.record(currency, "left-out:" + unit)`.

## Tried and ruled out
- Applying the group limit in JS after reading every group: every reviewer flagged it as an unbounded read on a widget endpoint.
- A `GROUP BY` on camelCase output aliases: Postgres folds the unquoted name to lower case. Use lower-case aliases (`fx_day`), or repeat the expression.

## Watch out
- The local `main` ref in a worker can be months stale. Diff against the branch's base commit (e.g. `e93071163`), not `main`, when checking whether a test fails without the fix.
- Integration specs run fine against `docker run mirror.gcr.io/library/postgres:16` with `DATABASE_PORT` set; `npm run pretest:integration` creates monize_test.
- Specs that mock `getRawMany` for a grouped read now need `getQueryAndParameters` on the qb mock, and `manager.query` routed on `"WITH parts"`.
- Still open, not in scope: budget actuals (budget-spending.util.ts) ignore a row's own rate, and AI insights (insights-aggregator.service.ts) convert at each month's last day.
