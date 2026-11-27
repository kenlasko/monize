---
title: "Transfer categories PR 5: docs, e2e, locales, retiring the plan"
author: Node
date: 2026-11-27
branch: claude/issue-2457
cost: { minutes: 23, tokens: 319456 }
touches:
  - backend/src/i18n/locales/de/categories.json
  - backend/src/i18n/locales/de/errors.json
  - backend/src/i18n/locales/es/categories.json
  - backend/src/i18n/locales/es/errors.json
  - backend/src/i18n/locales/fr/categories.json
  - backend/src/i18n/locales/fr/errors.json
  - backend/src/i18n/locales/hi/categories.json
  - backend/src/i18n/locales/hi/errors.json
  - backend/src/i18n/locales/id/categories.json
  - backend/src/i18n/locales/id/errors.json
---

## Decided
- Closing PR of a plan: fold the plan's decisions, scope cuts and the ticked task list into the spec as a "Plan record" section, delete the plan pair, repoint citations (only the spec and the invariants catalog cited them; .trail learnings are left as written).
- Locale pass: list en keys changed since the first PR's parent, keep the ones still identical to en in a translated locale (de is the probe), translate by distinct English string, and assert placeholders match before writing.
- E2E for a budget line on a Transfer category: the line nets to zero when both accounts are in the budget, so the spec excludes the destination (budgets.config.excludedAccountIds).

## Tried and ruled out
- Running e2e in the Playwright image the repo pins in docs: the image must match the installed @playwright/test (v1.65.1-noble here, not v1.64.1).
- Seeding a docs screenshot's data and deleting only one transfer leg: delete both legs before the category, or the delete is refused as in use.

## Watch out
- backend/CLAUDE.md is held under a byte ceiling by instruction-files.spec.ts; an index edit must be net-zero in size.
- trail check flags description-text edits as "bringing back" ruled-out phrases; those were keyword matches, not reintroduced approaches.
