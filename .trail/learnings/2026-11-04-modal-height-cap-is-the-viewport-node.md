---
title: Modal height cap is the viewport less the backdrop inset
author: Node
date: 2026-11-04
branch: claude/issue-2019
cost: { minutes: 7, tokens: 62588 }
touches:
  - docs/frontend/screens-and-dialogs.md
  - frontend/src/components/settings/bank-sync/BankSyncPreviewModal.test.tsx
  - frontend/src/components/ui/Modal.test.tsx
  - frontend/src/components/ui/Modal.tsx
---

## Decided
- A content-sized Modal (not fixedHeight) caps at max-h-[calc(100dvh-2rem)] in frontend/src/components/ui/Modal.tsx; 2rem is the backdrop's p-4 on both edges, so change them together. Issue #2019: the old max-h-[90vh] scrolled long transaction forms on short desktop windows while the window still had room.
- fixedHeight panels keep h-[min(90vh,56rem)]: they have a fixed height whatever their content, so raising it would resize dialogs that already fit, which the issue said not to do.

## Tried and ruled out
- A JS resize observer: a CSS max-height already follows the window size and content, with no state.

## Watch out
- Modal.test.tsx "height cap" fails on any max-h-[N vh] fraction. BankSyncPreviewModal.test.tsx also asserts the class string.
- trail check flags screens-and-dialogs.md:33 for grid-cols because of older text on that line; it is a false positive.
