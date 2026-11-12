---
title: "What's New sections are styled by keyword on their heading, and the dialog must not import dashboard code"
author: Ken
date: 2026-11-11
branch: feat/release-1.21-tours
id: l-1eac4d23
scope: repo
status: active
src: agent
touches:
  - frontend/src/components/dashboard/widget-meta.tsx
  - frontend/src/components/reports/InvestmentPerformanceReport.chartUx.test.tsx
  - frontend/src/components/reports/InvestmentPerformanceReport.mobileWrapped.test.tsx
  - frontend/src/components/reports/InvestmentPerformanceReport.test.tsx
  - frontend/src/components/reports/InvestmentPerformanceReport.tsx
  - frontend/src/components/reports/PortfolioReturnChart.test.tsx
  - frontend/src/components/reports/PortfolioReturnChart.tsx
  - frontend/src/components/reports/ReportSwitcher.test.tsx
  - frontend/src/components/reports/ReportSwitcher.tsx
  - frontend/src/components/reports/SecurityPerformanceReport.tsx
---

## Decided
The What's New dialog sorts release-note sections into features (bordered rows with an area icon, a change count, only the first one open) and maintenance (fixes, operator notes, credits, under the hood, tests, "What's Changed"), which go in a quieter "Fixes and details" group after the features. Headings are free text in each release (about sixty distinct ones so far), so the classification is a first-match keyword list, maintenance rules first, and an unmatched heading falls back to a neutral feature style rather than failing.

## Watch out
The dialog also opens on the login screen, so it is part of the public client bundle. Importing anything from components/dashboard (even widget-meta, just for its tint class) drags the dashboard's message namespaces in, and the public-catalog guard fails with a list of eight namespaces to add. That list is the wrong fix: the shared tint class lives in its own lib module instead.

In the code:
- classifier and change counter: frontend/src/components/whats-new/section-style.ts
- shared puck tint: frontend/src/lib/tint-class.ts (TINT_CLASS, set --widget-tint to a chart token)
- guard: frontend/src/i18n/client-messages.guard.test.ts
