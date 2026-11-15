---
title: "Frontend tests: a heading InfoTooltip's text appears only after the modal's rAF autofocus"
author: Node
date: 2026-11-15
branch: claude/issue-2209
cost: { minutes: 3, tokens: 29889 }
touches:
  - frontend/src/components/settings/SupportBackupModal.test.tsx
---

## Decided
- `SupportBackupModal.test.tsx` now finds the de-identification note with `getByRole('button', { name: /de-identified copy/i })`. An `InfoTooltip` puts its text in the button's `aria-label`. With `usePortal`, the popover text is in the DOM only while the tooltip is open.

## Tried and ruled out
- Keeping `getByText` on the tooltip text. It passes only when `Modal`'s `requestAnimationFrame` autofocus lands on the help button before the assertion runs, which opens the popover. On a loaded CI shard that frame had not fired yet, so the test failed. You can reproduce this by stubbing `requestAnimationFrame` to `() => 0`.

## Watch out
- `Modal` skips the help icon when it autofocuses, but only inside `[data-modal-heading]`, which `Modal` renders when given its own `title` prop. Dialogs that draw their own `<h2>` plus `InfoTooltip` (SupportBackupModal, the export password, disable-2FA and create-share modals) get their help popover opened by focus on every open. That is a product defect, not fixed here.
