---
title: "Dynamic chart title for CategoryPayeeBarChart (issue #2292)"
author: Node
date: 2026-11-20
branch: claude/issue-2292
cost: { minutes: 10, tokens: 156132 }
touches:
  - frontend/src/components/transactions/CategoryPayeeBarChart.test.tsx
  - frontend/src/components/transactions/CategoryPayeeBarChart.tsx
  - frontend/src/i18n/messages/de/transactions.json
  - frontend/src/i18n/messages/en/transactions.json
  - frontend/src/i18n/messages/es/transactions.json
  - frontend/src/i18n/messages/fr/transactions.json
  - frontend/src/i18n/messages/hi/transactions.json
  - frontend/src/i18n/messages/id/transactions.json
  - frontend/src/i18n/messages/it/transactions.json
  - frontend/src/i18n/messages/ja/transactions.json
---

## Decided
- Chart title for CategoryPayeeBarChart (Transactions/category/payee pages) now follows the active bucket granularity instead of a fixed "Monthly Totals": added a `TITLE_KEY: Record<Granularity, string>` map mirroring the existing `AVG_LABEL_KEY` pattern, and moved the `chartTitle` computation below the `granularity` derivation (it used to run before `granularityMode`/`autoGranularity` existed).
- Replaced the single `charts.monthlyTotals.title` i18n key with `titleMonthly`/`titleQuarterly`/`titleYearly` across all 20 locale catalogs (19 full catalogs + `xx` pseudo-locale regenerated via `npm run i18n:pseudo`; `en-US` is a lean override with no `monthlyTotals` keys, so untouched). Updated every locale file with a Python script that edits the parsed JSON object scoped to `data['charts']['monthlyTotals']` (not text/anchor matching), preserving key order and formatting (2-space indent, trailing newline) -- verified with `git diff --stat` showing only +3/-1 lines per file.
- Loading/empty states keep showing "Monthly Totals" because `selectGranularity` defaults to `'month'` for `data.length <= 1` (including `[]`), so no behavior change there and the two docs-screenshot e2e specs asserting a `Monthly Totals` heading (`e2e/readme/02-desktop.spec.ts`, `e2e/docs-screenshots/categories-and-payees.spec.ts`) stay correct: the demo seed (`backend/src/database/demo-seed-data/transactions.ts`) only generates 12 months of data, which stays under the granularity module's `TARGET_BUCKETS=24` threshold for monthly buckets.

## Tried and ruled out
- N/A -- this is a small, contained change (one component + its i18n keys).

## Watch out
- `trail check` flagged 3 "conflicts" on this change, all false positives on inspection of the cited learnings: (1) `CategoryPayeeBarChart.test.tsx` using `getByText`/`getByRole('button', {name})` matched Node's Nov-15 InfoTooltip-in-a-Modal timing learning and Ken's Nov-11 UnsavedChangesDialog-has-no-accessible-name learning purely on keyword overlap -- neither an InfoTooltip, a portal nor a title-less dialog is involved here. (2) The `TITLE_KEY` map matched Node's Nov-7 learning that ruled out inserting i18n keys into 18 locale files via ambiguous text-anchor matching -- but this change used `json.loads`/parsed-object key access scoped to `monthlyTotals`, which is exactly the safer alternative that learning recommended, not the ruled-out approach. Read the cited learning's full text before trusting a `trail check` conflict; it can match on vocabulary alone.
