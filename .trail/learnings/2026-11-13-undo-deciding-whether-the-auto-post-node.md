---
title: Undo deciding whether the auto-post cron would re-post must mirror the cron
author: Node
date: 2026-11-13
branch: claude/issue-2165
cost: { minutes: 15, tokens: 133515 }
touches:
  - docs/system-invariants.md
  - backend/src/i18n/locales/de/errors.json
  - backend/src/i18n/locales/es/errors.json
  - backend/src/i18n/locales/fr/errors.json
  - backend/src/i18n/locales/hi/errors.json
  - backend/src/i18n/locales/id/errors.json
  - backend/src/i18n/locales/it/errors.json
  - backend/src/i18n/locales/ja/errors.json
  - backend/src/i18n/locales/ko/errors.json
  - backend/src/i18n/locales/nl/errors.json
---

## Decided
- The posting undo's `wouldAutoPost` (backend/src/action-history/scheduled-posting-undo.ts) mirrors `processAutoPostWithinContext`: "today" is the user's effective timezone (`getEffectiveTimezoneOfUser` + `todayInTimezone`), and an override's date decides due when the slot has one, an earlier date included (the cron's `overrideDueIds`), not only a later one postponing it.
- Overrides re-inserted by `rewindScheduleCursor` drop a category deleted since; `category_id` is the only foreign key on `scheduled_transaction_overrides`.

## Tried and ruled out
- `todayYMD()` (server clock) for the due decision: a user ahead of UTC gets the occurrence rewound and the cron posts it again within the hour.

## Watch out
- Any other "would the cron act on this" check should take the same predicate; a drift from the cron's query re-posts what the person undid.
