---
title: "Delete My Data left transaction_rules and institutions behind (#2231)"
author: Node
date: 2026-11-16
branch: claude/issue-2231
cost: { minutes: 13, tokens: 183928 }
touches:
  - frontend/src/components/settings/DangerZoneSection.tsx
  - frontend/src/i18n/messages/de/settings.json
  - frontend/src/i18n/messages/en/settings.json
  - frontend/src/i18n/messages/es/settings.json
  - frontend/src/i18n/messages/fr/settings.json
  - frontend/src/i18n/messages/hi/settings.json
  - frontend/src/i18n/messages/id/settings.json
  - frontend/src/i18n/messages/it/settings.json
  - frontend/src/i18n/messages/ja/settings.json
  - frontend/src/i18n/messages/ko/settings.json
---

## Decided
- `UsersService.runOwnedDataDeletes` (backend/src/users/users.service.ts) is the
  "Delete Data" / purgeForDowngrade implementation, separate from
  `deleteAllUserData` in backend/src/backup/restore-wipe.ts (full account wipe
  used by backup restore). The two had diverged: restore-wipe always deleted
  `transaction_rules` and `institutions`, runOwnedDataDeletes deleted neither,
  because the account row survives "Delete Data" so the users(id) ON DELETE
  CASCADE on both tables never fires.
- Fixed by always deleting both in runOwnedDataDeletes, same bucket as
  transactions/budgets/action_history (not gated behind an optional flag like
  deleteAccounts/deleteCategories). institutions' FK from accounts.institution_id
  is ON DELETE SET NULL, so deleting institutions is safe regardless of whether
  deleteAccounts also removes the accounts that referenced them.
- Updated the matching UI copy (DangerZoneSection "always deleted" list),
  en + 17 other full locales, the xx pseudo-locale, and
  website/docs/settings-and-security.md (+ regenerated .html/search-index.json
  via `npm run docs:build`).

## Tried and ruled out
- Did not add "Institutions"/"Rules" as new optional checkboxes next to
  Accounts/Categories/Payees/Currency preferences -- the issue wants them gone
  unconditionally like the backup-restore wipe already does, not a third way to
  configure the deletion.

## Watch out
- `backend/` and `frontend/` have no node_modules in a fresh worktree; `npm ci`
  in each is required before jest/tsc/eslint or vitest/tsc/eslint will run.
- Plain `npx tsc --noEmit` can OOM on this box's heap; run
  `node --max-old-space-size=4096 node_modules/typescript/bin/tsc --noEmit -p tsconfig.json`
  instead (worked for both backend and frontend here).
- `trail check` flagged 6 "conflicts" purely from lexical overlap inside the
  giant single-line website/docs/search-index.json blob (words like "account",
  "institution", "password" matching unrelated past-ruled-out learnings) --
  not real conflicts; verified by reading the flagged learnings.
