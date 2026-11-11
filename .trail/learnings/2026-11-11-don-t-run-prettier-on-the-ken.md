---
title: "Don't run Prettier on the frontend; it isn't Prettier-formatted under any settings"
author: Ken
date: 2026-11-11
branch: feature/portfolio-twr-chart
id: l-5b69f0ac
scope: repo
status: active
src: agent
touches:
  - backend/src/net-worth/invested-period-result.util.ts
  - backend/src/net-worth/invested-twr-series.util.spec.ts
  - backend/src/net-worth/invested-twr-series.util.ts
  - backend/src/net-worth/net-worth.controller.spec.ts
  - backend/src/net-worth/net-worth.controller.ts
  - backend/src/net-worth/portfolio-twr-series.service.spec.ts
  - backend/src/net-worth/portfolio-twr-series.service.ts
  - docs/specs/portfolio-twr-series.md
  - frontend/src/components/reports/InvestmentPerformanceReport.mobileWrapped.test.tsx
  - frontend/src/components/reports/InvestmentPerformanceReport.tsx
---

## Decided
Edit frontend files by hand and check them with ESLint only. The pre-commit hook does the same: lint-staged runs only ESLint on frontend/ and backend/, and Prettier only on e2e/.

## Tried and ruled out
Running Prettier on the files a change touched. frontend/ has no Prettier config, so bare Prettier switched to double quotes and reflowed whole files: a small addition to lib/constants.ts became a +204-line diff. Running it with `--single-quote` at width 100 or 120 still rewrote hundreds of lines in InvestmentPerformanceReport.tsx, so no setting reproduces the house style. The files had to be restored from HEAD and the edits applied again.

## Watch out
On the backend, Prettier leaves existing code unchanged, so running it there is safe.

In the code:
- frontend/: `npx eslint --max-warnings=0 <files>`, never `npx prettier --write`
- .lintstagedrc.cjs: Prettier only on `e2e/**`
