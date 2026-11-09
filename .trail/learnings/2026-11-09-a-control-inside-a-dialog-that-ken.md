---
title: "A control inside a dialog that claims Tab must also stop the event, and a payee's default category is not an auto-set category"
author: Ken
date: 2026-11-09
branch: feat/command-palette
id: l-e4481bc4
scope: repo
status: active
src: agent
touches:
  - backend/src/users/dto/update-preferences.dto.ts
  - backend/src/users/validators/is-view-defaults.validator.spec.ts
  - backend/src/users/validators/is-view-defaults.validator.ts
  - backend/src/users/view-defaults.ts
  - docs/frontend/ui-conventions.md
  - e2e/readme/04-mobile.spec.ts
  - e2e/readme/05-recordings.spec.ts
  - frontend/src/app/ai/page.tsx
  - frontend/src/app/dashboard/page.tsx
  - frontend/src/app/globals.css
---

## Decided
A control in a Modal that handles Tab itself calls stopPropagation as well as preventDefault. Modal's focus trap listens on document and does not look at defaultPrevented, so preventDefault alone still moves focus. Only the Tab branch stops the event, so Escape still reaches Modal.

A category that comes from a payee is passed with the payee, not as the form's default category. The default-category path marks the value as auto-set from an asset account, and choosing an account then clears or replaces it.

## Tried and ruled out
Passing the payee's category through the existing default-category prop: it looked right until an account was selected. A browser check with a mock payee that had no default category did not catch it.

## Watch out
Do not run git stash to compare before and after in this checkout: intent-to-add files make it fail, and other sessions may have uncommitted work here. Check out the commit in a detached worktree, symlink frontend/node_modules, copy in the new tests and run them there.

In the code: frontend/src/components/ui/Modal.tsx (focus trap), frontend/src/components/command-palette/CommandPalette.tsx (Tab branch), frontend/src/components/transactions/TransactionForm.tsx (defaultPayee, categoryWasAutoSetRef).
