---
title: jsdom 31 changes how CSS transforms and var() colours read back in tests
author: Node
date: 2026-11-15
branch: claude/issue-2186
cost: { minutes: 5, tokens: 47661 }
touches:
  - frontend/src/components/layout/AppHeader.mobile.test.tsx
  - frontend/src/components/strategies/GemPrimitives.test.tsx
  - frontend/src/components/transactions/DocumentScanDialog.test.tsx
  - frontend/src/hooks/useGridReorder.test.ts
  - frontend/src/hooks/useSwipeNavigation.test.ts
  - frontend/src/hooks/useSwipeToPaginate.test.ts
---

## Decided
- jsdom 30.1.3 -> 31.0.0 (#2189) serializes el.style.transform like a browser: translateX(0) -> translateX(0px), translate3d(x, y, 0) -> translate3d(x, y, 0px), translateY(-0px) -> translateY(0px), translate(0px, 0px) -> translate(0px). Tests asserting the old strings were updated to the new ones.
- getComputedStyle now resolves var() against the test document (which loads no theme), so toHaveStyle({ backgroundColor: "var(--x)" }) fails even though the inline style holds it. Assert el.style.backgroundColor instead.
## Watch out
- When updating `toBe(old)`, also update any paired `not.toBe(old)`; otherwise it passes trivially.
- To find more of these: grep tests for `style.transform).toBe(` and `toHaveStyle` with `var(`, then run those files. Run date-sensitive frontend tests with TZ=UTC on this machine or they fail after UTC midnight.
