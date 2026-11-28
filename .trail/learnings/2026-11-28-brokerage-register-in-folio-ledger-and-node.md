---
title: "Brokerage register in Folio ledger and Pebble day blocks at desktop widths (issue #2510)"
author: Node
date: 2026-11-28
branch: claude/issue-2510
cost: { minutes: 15, tokens: 140148 }
touches:
  - docs/frontend/tables-and-registers.md
  - frontend/src/components/investments/InvestmentTransactionList.tsx
  - frontend/src/components/investments/InvestmentTransactionList.uiStyles.test.tsx
  - frontend/src/components/investments/variants/InvestmentPebbleRegister.tsx
  - website/docs/investments.html
  - website/docs/investments.md
  - website/docs/search-index.json
  - frontend/src/components/investments/InvestmentTransactionList.mobileWrapped.test.tsx
  - frontend/src/components/investments/variants/InvestmentDayHeading.tsx
---

## Decided
- The maintainer took every recommendation. Folio is the ledger at every width and density: `ui-register` table, `ui-register-row` + `data-band` rows, `InvestmentDayHeading` group rows spanning `colCount` in place of the Date column, Total as the single `ui-register-money` column, dense status marks plus a legend. Pebble from `sm` up uses `InvestmentPebbleRegister` (day blocks, no inspector; a click opens the editor). Phones keep the #2508 layout. No day figure and no footer.
- The Pebble trade row keeps `RowActions` (compact). Without an inspector it is the only visible way to Duplicate or Delete.
## Tried and ruled out
- Putting `hidden lg:flex` on `.ui-register-legend` itself: its `display: flex` rule in `ui-styles-register.css` is unlayered, so it beats the utility. Wrap the legend in `<div className="hidden lg:block">` instead.
## Watch out
- `trail check` flags about 20 lexical matches on this change (balance beside the newest row, registerColumnClass footers). None apply: the brokerage register prints no balance and draws no footer.
- The cash Folio legend shows "c" while `StatusCellButton` dense shows "C", and the legend has no Void or Pending mark. This predates #2510 and was left as is.
