---
title: Detail pages hand their entity switcher to the mobile header; switchers offer active entities only
author: Node
date: 2026-11-19
branch: claude/issue-2284
cost: { minutes: 14, tokens: 172394 }
touches:
  - docs/frontend/ui-conventions.md
  - "frontend/src/app/categories/[id]/page.tsx"
  - "frontend/src/app/currencies/[code]/page.tsx"
  - "frontend/src/app/payees/[id]/page.tsx"
  - "frontend/src/app/securities/[id]/page.tsx"
  - frontend/src/components/categories/detail/CategoryDetailHeader.test.tsx
  - frontend/src/components/categories/detail/CategoryDetailHeader.tsx
  - frontend/src/components/categories/detail/CategorySwitcher.test.tsx
  - frontend/src/components/categories/detail/CategorySwitcher.tsx
  - frontend/src/components/currencies/detail/CurrencyDetailHeader.test.tsx
---

## Decided
- Payee, category, security and currency detail headers pass "<List> - <name>" and their caret to the collapsed app header through `useCollapsingHeaderTitle`, the same way `ReportDetailHeader` does.
- Each `*Switcher.tsx` now exports a hook (`usePayeeSwitcher`, `useCategorySwitcher`, `useSecuritySwitcher`, `useCurrencySwitcher`), not a component. It returns `EntitySwitcher`'s props, memoized, and builds the route itself. The headers no longer take `onSelect*` props.
- The hook leaves out inactive payees, securities and currencies, on the page caret and the header caret alike (issue #2284). Categories have no inactive state.
- `CollapsedHeaderSwitcher` gained `secondaryAlign`, so the security menu stays inline in the header.

## Tried and ruled out
- Keeping the `onSelect` props and memoizing the router push in each page: the headers render after the pages' early returns, and an inline arrow gives the switcher a new identity on every render, which makes the collapsed-title effect publish again each time.

## Watch out
- A test that renders one of these hooks needs a stable router mock (`vi.hoisted(() => ({ push: vi.fn() }))`). A fresh object per call changes the memo on every render.
- No `CurrencyDetailHeader.test.tsx` existed before this change; it was added alongside it.
