---
title: Investments pinned bar names the selected accounts in its title and opens the multi-account picker from a caret
author: Ken
date: 2026-11-18
branch: feat/investments-bar-account-label
cost: { minutes: 3, tokens: 79903 }
id: l-19f39162
scope: repo
status: active
src: agent
touches:
  - frontend/src/components/ui/MultiSelect.tsx
  - frontend/src/app/investments/page.tsx
---

## Decided
- The desktop pinned bar on Investments reads "Investments – <the Portfolio Summary bracket label>" ("All Accounts", "CA-RRSP, US-RRSP", "All but TFSA"), with a down chevron beside it that opens the same multi-account MultiSelect. The maintainer asked for this, and it replaces the #2277 layout ("Investments" plus the full MultiSelect field). It still picks many accounts. The phone header's single-pick caret is unchanged.
- The chevron is a new `variant="caret"` on MultiSelect, not EntitySwitcher, because EntitySwitcher picks only one. It is styled like EntitySwitcher's caret. Its menu is at least 256px wide (the caret is ~28px) and is clamped inside the viewport.
- The title text goes through `layout.pageHeader.collapsedTitleWithContext`, the catalog entry the phone header uses, so the two lines read the same.

## Watch out
- The page test's MultiSelect mock gives the caret variant the testid `multi-select-caret`. The floating-bar IntersectionObserver stub finds the header picker by `[data-testid="multi-select"]`, so the two must not share a testid.
- The docs picture images/investments-floating-bar.png still shows the old bar until the docs screenshots are captured again.

In the code: frontend/src/components/ui/MultiSelect.tsx (`variant`, `CARET_MENU_MIN_WIDTH`), `accountOptions` and `investments-floating-title` in frontend/src/app/investments/page.tsx, investments `page.chooseAccounts` in every locale.
