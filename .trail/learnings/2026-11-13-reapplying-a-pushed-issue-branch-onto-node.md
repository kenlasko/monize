---
title: Reapplying a pushed issue branch onto a reset worktree (issue 2149)
author: Node
date: 2026-11-13
branch: claude/issue-2149
cost: { minutes: 14, tokens: 71783 }
touches:
  - frontend/src/i18n/messages/de/reports.json
  - frontend/src/i18n/messages/es/reports.json
  - frontend/src/i18n/messages/fr/reports.json
  - frontend/src/i18n/messages/hi/reports.json
  - frontend/src/i18n/messages/id/reports.json
  - frontend/src/i18n/messages/it/reports.json
  - frontend/src/i18n/messages/ja/reports.json
  - frontend/src/i18n/messages/ko/reports.json
  - frontend/src/i18n/messages/nl/reports.json
  - frontend/src/i18n/messages/pl/reports.json
---

## Decided
- When the local issue branch sits at main but origin/claude/issue-<n> already carries the work, cherry-pick its non-merge commits onto HEAD instead of redoing them.
- In aggregateNoGrouping the split path is now conv.convert(amount, tx, split) (own-rate per line); keep the split argument when adding fields there.
## Tried and ruled out
- Merging search-index.json hunks by hand: resolve by taking either side and re-running `npm run docs:build` in frontend/ (needs `npm ci` first).
## Watch out
- `trail check` flags comments saying a column has "no total" as bringing back the ruled-out "total column"; this is a lexical false positive.
- `npm run typecheck` in backend/ can run out of heap here; `NODE_OPTIONS=--max-old-space-size=4096 npx tsc --noEmit -p tsconfig.test.json` passes.
