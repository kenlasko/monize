---
title: "Pinned bars: a render-phase sync must not feed useScrolledPast a stale enabled; Investments bar picks many accounts"
author: Node
date: 2026-11-18
branch: claude/issue-2277
cost: { minutes: 36, tokens: 261292 }
touches:
  - frontend/src/app/investments/page.test.tsx
  - frontend/src/app/investments/page.tsx
  - website/docs/images/investments-floating-bar.light.png
  - website/docs/images/investments-floating-bar.png
  - website/docs/investments.html
  - website/docs/investments.md
  - website/docs/search-index.json
  - frontend/src/app/transactions/page.test.tsx
  - frontend/src/app/transactions/page.tsx
---

## Decided
- Transactions: `accountBandActive` is derived from this render's filter (`singleFilteredAccount && !singleFilteredPayee && !singleFilteredCategory`), not from `retainedWidget`. On the render that switches accounts, `retainedWidget` still holds the previous account until its render-phase `setRetainedWidget` re-renders. `useScrolledPast` read `enabled=false` on that discarded pass and reset `past` (its own render-phase reset). The committed `enabled` stayed true, so the effect never re-ran, the IntersectionObserver never reported again, and the floating account bar stayed hidden until the reader scrolled to the top and back (#2277).
- Investments, desktop pinned bar: the section name plus the header's own `MultiSelect` (one `accountPicker` element rendered in both places) replaces the single-pick `EntitySwitcher` caret. This reverses the Nov 18 decision on feat/transactions-account-info-bar, at the maintainer's request in #2277. The phone header's collapsed title keeps the "Investments – <label>" text and its single-pick caret; the issue was about the desktop bar.

## Tried and ruled out
- Fixing it inside `useScrolledPast` by resetting `past` in the effect cleanup: when the watched heading moves (widget h3 to the in-band bar h3) the bar would hide for a frame and replay its 300ms slide.

## Watch out
- Any hook with a render-phase "previous value" reset, called after a render-phase `setState` in the same component, sees that render's stale inputs and keeps the reset even though the render is thrown away. Feed such hooks values that are already right on the first pass.
- jsdom has no IntersectionObserver. The page test reproduces the bug by stubbing it and checking that the observed h3 is the same element before and after the switch (no new observer report), then that the bar is still shown.
- `MultiSelect` closes on any capture-phase scroll. A Playwright `mouse.wheel` scroll, or the page re-laying out while it settles, can close it right after it opens, in the header as well as in the bar. Use `window.scrollTo` in a browser check.
