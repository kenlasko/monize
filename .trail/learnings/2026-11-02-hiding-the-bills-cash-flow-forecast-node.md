---
title: Hiding the Bills cash flow forecast chart (issue 1987)
author: Node
date: 2026-11-02
branch: claude/issue-1987
cost: { minutes: 19, tokens: 103521 }
touches:
  - website/docs/bills-and-deposits.html
  - website/docs/bills-and-deposits.md
  - website/docs/images/cash-flow-forecast.light.png
  - website/docs/images/cash-flow-forecast.png
  - website/docs/search-index.json
  - frontend/src/components/bills/CashFlowForecastChart.test.tsx
  - frontend/src/components/bills/CashFlowForecastChart.tsx
---

## Decided
- Reused ChartCollapseButton / CollapsedChartStrip from components/transactions/ChartCollapseControls (transactions namespace strings, already in every client scope), so no new i18n keys.
- State is useLocalStorage('cashFlowForecast.collapsed'), only `=== true` folds; no account view-default (Transactions has chartCollapsed default, bills does not).
- The collapse check returns before the loading/missing-currency branches; hooks (useCashFlowForecast) still run above it.

## Tried and ruled out
- Running prettier on frontend files: the frontend has no prettier config (lint-staged runs only eslint there), so prettier rewrites quotes across the file. Use eslint only.

## Watch out
- Docs screenshot retake worked with the e2e stack plus an override dropping ports (`ports: !reset []`), and Playwright in mcr.microsoft.com/playwright:v1.64.1-noble on issue-N_e2e-network with a node TCP proxy localhost:3001 -> frontend:3000 started inside the container. Run docs:admin, then the DEMO_MODE=true seed.js exec, then docs:screenshots -g <name>. oxipng is not installed on the worker.
- trail check flags lexical false positives on CashFlowForecastChart (term overlap with unrelated learnings).
