---
title: A Tailwind class glued to a template expression is never generated
author: Ken
date: 2026-11-06
branch: feat/help-panel
id: l-76b2298b
scope: repo
status: active
src: agent
touches:
  - frontend/src/components/layout/SwipeShell.tsx
  - frontend/src/components/layout/SwipeShell.test.tsx
  - e2e/tests/shared-expenses-final-review.spec.ts
---

## Decided
- Join conditional classes with `cn()` from plain string literals (or leave a space before the `${`), never `"... some-class${cond ? ' other' : ''}"`. Tailwind v4 finds utilities by scanning the source for whole tokens; `overflow-x-clip${` is one token, so `overflow-x-clip` was never generated.
- The shell's own test now reads the source and fails a glued `overflow-x-clip`.

## Tried and ruled out
- Looking for the overflow in the help panel or the header code: the panel was closed and the header unchanged. The header has always been wider than a 1280 px viewport; the shell's clip hid it. The clue was the computed style: the element carried the class, but getComputedStyle said overflow-x was visible.
- Trusting a className assertion: `expect(el.className).toContain('overflow-x-clip')` passed throughout, because the class name is there; only its CSS rule is missing.

## Watch out
- About 11 other class lists on main use the same glued pattern (currencies page, Modal, Tabs, InstitutionList, BankSyncPreviewList, PayeeListParts). Each works only while the same class also appears somewhere as a plain token, so removing that other use breaks it silently. A source guard with a shrink-only baseline was proposed, not built.
- To find what makes a page scroll sideways, list elements whose bounding right edge exceeds innerWidth and print each one's ancestor chain with getComputedStyle(p).overflowX, from a throwaway spec against the e2e stack.

In the code:
- frontend/src/components/layout/SwipeShell.tsx (cn from '@/lib/utils')
- frontend/src/components/layout/SwipeShell.test.tsx: "spells overflow-x-clip as a token Tailwind can find in the source"
- e2e/tests/shared-expenses-final-review.spec.ts: the scrollWidth <= innerWidth check that caught it
- find others: grep -rnE '[A-Za-z0-9\])]\$\{' frontend/src --include=*.tsx | grep className
