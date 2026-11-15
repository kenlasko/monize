---
title: "Adding translated keys to a locale file must insert them in place, never rebuild the file in the English key order"
author: Ken
date: 2026-11-15
branch: feat/bucket-budget
cost: { minutes: 1, tokens: 1217 }
id: l-0a710219
scope: repo
status: active
src: agent
touches:
  - frontend/src/i18n/messages/ko/settings.json
  - frontend/src/i18n/messages/de/budgets.json
  - backend/src/i18n/locales/de/errors.json
  - frontend/src/i18n/messages.parity.test.ts
---

## Decided
- New translations go into a locale catalog by inserting each missing key after its nearest earlier English sibling, leaving every existing key and its order alone. The diff is then insertions only.

## Tried and ruled out
- Rebuilding each locale file by walking the English catalog: it reordered existing keys (noisy diffs in the settings catalogs) and an agent reported two Korean keys dropped. All locale files were restored from git and re-merged.

## Watch out
- Locale catalogs do not all share the English key order, so any tool that assumes it will churn them.

In the code:
- frontend/src/i18n/messages/ko/settings.json, frontend/src/i18n/messages/de/budgets.json, backend/src/i18n/locales/de/errors.json, frontend/src/i18n/messages.parity.test.ts
