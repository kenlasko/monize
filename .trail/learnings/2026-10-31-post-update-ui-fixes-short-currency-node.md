---
title: "Post-update UI fixes: short currency Usage, two-line refresh age, chart Y axis margin, Search placement (#1970)"
author: Node
date: 2026-10-31
branch: claude/issue-1970
cost: { minutes: 20, tokens: 196434 }
touches:
  - website/docs/currency-management.html
  - website/docs/currency-management.md
  - website/docs/images/currencies-page.light.png
  - website/docs/images/currencies-page.png
  - website/docs/images/investments-page.light.png
  - website/docs/images/investments-page.png
  - website/docs/images/securities-list.light.png
  - website/docs/images/securities-list.png
  - website/docs/images/transaction-filters.light.png
  - website/docs/images/transaction-filters.png
---

## Decided
- Currencies Usage column stays abbreviated ("16 accts, 3 secs"); the long form widened the table until Actions scrolled out of view. Locales that abbreviated before (de, es, fr, nl, pl, ru, tr, uk) were restored to their short forms; ja/zh/ko/vi/it/pt/hi/id are short already.
- A refresh button's age is a second line under its label, drawn by frontend/src/components/ui/RefreshButtonLabel.tsx for both Refresh Rates (currencies page) and RefreshPricesButton (Investments, Securities). currencies.page.ratesAge was dropped; the parens are literal, as RefreshPricesButton always had them.
- Transactions filter panel: Search is the last field of the second grid row, right of Attachments, with its visible label. The maintainer wants it there, not first on the account-status line.
- Account Balances chart: margin.left is 0. With YAxis width="auto", a negative left margin pushes the auto-sized axis out of the overflow-hidden box and clips the "$" of every tick.

## Watch out
- The maintainer reported "(Yesterday)" vs "(yesterday)" on Investments; no code path producing the capitalised form was found (useRelativeTime / Intl gives lowercase). Both buttons now share one label component.
- IncomeExpensesBarChart (dashboard) still uses left: -10, but with a fixed-width YAxis; not touched here.
