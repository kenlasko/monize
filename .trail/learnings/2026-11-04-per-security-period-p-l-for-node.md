---
title: "Per-security period P&L for the Investment Performance report (issue 2011)"
author: Node
date: 2026-11-04
branch: claude/issue-2011
cost: { minutes: 30, tokens: 263404 }
touches:
  - frontend/src/i18n/messages/de/reports.json
  - frontend/src/i18n/messages/es/reports.json
  - frontend/src/i18n/messages/fr/reports.json
  - frontend/src/i18n/messages/hi/reports.json
  - frontend/src/i18n/messages/id/reports.json
  - frontend/src/i18n/messages/it/reports.json
  - frontend/src/i18n/messages/ja/reports.json
  - frontend/src/i18n/messages/ko/reports.json
  - frontend/src/i18n/messages/nl/reports.json
  - frontend/src/i18n/messages/pl/reports.json
---

## Decided
- Rows are investedPeriodResult run per security (security-period-result.util.ts) over DailyPositions.closeValues from getDailyInvestmentPositions plus loadInvestedCapitalFlowRows grouped by securityId and folded with foldInvestedFlows on ONE rate index. Rows + unattributedPnl (rows with no security) reconcile with the card's investmentPnl.
- The window is drawn by PortfolioPeriodResultService.measuredFrom (extracted from getPeriodResult), so cards and rows open on the same close. Route: GET /net-worth/investments-period-result/securities; the controller's periodWindowQuery validates both period routes.
- Client: useSecurityPeriodResults names the window like usePortfolioPeriodResult (periodBaselineDate for MTD); both take skip until the report's accounts load, so a single-account request is not first sent in the wrong currency. PORTFOLIO_CHART_RANGES is the shared ten-range list.
- % Change is quoted close to close (positionCloseAsOf), withheld with splitInWindow when a SPLIT row is in the window.

## Tried and ruled out
- Client-side (price change x shares): wrong across trades and cannot reconcile with the card.

## Watch out
- Moving JSX out of a baselined file into a new one trips ui-conventions twice: the new file must use CARD_CLASS / TABLE_CLASS / TABLE_BODY_CLASS / HOVER_ROW_ON_CARD, and the old file must be REMOVED from the shrink-only baselines it no longer offends.
- usePortfolioPeriodResult now returns `failed`; a toEqual on its whole return value needs the field.
- 'all' on the report runs two since-inception folds (series and positions); the in-flight key differs by collectPositions.
