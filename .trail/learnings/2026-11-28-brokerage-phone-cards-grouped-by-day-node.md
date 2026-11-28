---
title: "Brokerage phone cards grouped by day in Folio and Pebble (issue #2508)"
author: Node
date: 2026-11-28
branch: claude/issue-2508
cost: { minutes: 12, tokens: 70939 }
touches:
  - docs/frontend/tables-and-registers.md
  - website/docs/investments.html
  - website/docs/investments.md
  - website/docs/search-index.json
  - frontend/src/components/investments/InvestmentTransactionList.mobileWrapped.test.tsx
  - frontend/src/components/investments/InvestmentTransactionList.tsx
  - frontend/src/components/investments/InvestmentTransactionListParts.tsx
  - frontend/src/components/investments/variants/InvestmentDayHeading.tsx
---

## Decided
- The maintainer chose phone only and the date alone. `InvestmentDayHeading` (`frontend/src/components/investments/variants/InvestmentDayHeading.tsx`, through `renderForStyle`) draws Folio's `th.ui-register-group` or Pebble's Today/Yesterday/date title before each day's first wrapped card. `InvestmentTransactionCardBody` takes `showDate={false}` under it.
- Folio's phone eyebrow look comes for free: the card carries `ui-register-card-grouped`, and `ui-styles-register.css` keys on `table:has(.ui-register-card-grouped) .ui-register-group`. The investment card already has the same grid columns that marker sets.
- Several cash accounts keep the day net (no backend multi-account seed). The maintainer agreed.
## Tried and ruled out
- `wrapped && useUiStyle() !== 'standard'` calls the hook conditionally through the short-circuit. Read the style into a const first.
## Watch out
- `InvestmentTransactionList.tsx` is already about 900 lines, over the 800 cap, so new pieces go in `variants/` or `InvestmentTransactionListParts.tsx`.
- `npm run type-check` hits the default heap limit here; `NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit` passes.
