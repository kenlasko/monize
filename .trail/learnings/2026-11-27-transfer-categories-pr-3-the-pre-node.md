---
title: "Transfer categories PR 3: the pre-PR review's second sweep (#2454)"
author: Node
date: 2026-11-27
branch: claude/issue-2454
cost: { minutes: 61, tokens: 360326 }
touches:
  - backend/src/import/mny/mny-import.service.spec.ts
  - backend/src/ai/query/tool-definitions.ts
  - backend/src/i18n/locales/de/errors.json
  - backend/src/i18n/locales/en/errors.json
  - backend/src/i18n/locales/es/errors.json
  - backend/src/i18n/locales/fr/errors.json
  - backend/src/i18n/locales/hi/errors.json
  - backend/src/i18n/locales/id/errors.json
  - backend/src/i18n/locales/it/errors.json
  - backend/src/i18n/locales/ja/errors.json
---

## Decided
- A model's category name resolves against ALL categories; `resolveCategoryNamePaths(…, { prefer })` only breaks ties inside one tier (exact, path, leaf). Resolving per type group let the leaf fallback pick a same-named category of the other type.
- A rule's split part naming a Transfer category is planned as a skip (`category_does_not_fit`, reported as `transfer_category_on_category_row`); `chainsFor` must load split-part ids or the planner can't know the type.
- A run hands the planner the other side's category (`RulePlanContext.otherSideCategoryId`: a pair's other leg, or the split line read under its parent's lock) so `set_category` repairs legs that differ.
- `create`, a scheduled posting, `applyToNew`, override writes and the three undos take `lockCategoryOwnerShared` as their first statement.
- Import notices count only a found Transfer category (`categoryRowFit`); Money counts in `writeTransactions`, where the holder is decided.

## Tried and ruled out
- Adding `categoryName?` to the AI rule-action help: `RULE_ACTIONS_HELP` sits at its 300-character cap.
- Replacing `categoryIdForCategoryRow` with `categoryRowFit` in a writer: the category-fit guard recognises the former (FIT_HELPERS) and fails the file; keep it as the gate and ask the cached fit only to count.

## Watch out
- Scheduled split DTO: per-field `@ValidateIf` that skips when the OTHER id is set turns off UUID checks on the normal transfer-line shape.
- Frontend tests that mock `@/lib/categoryUtils` wholesale break on any new builder; spread `importOriginal`.
- A frontend locale overlay (en-US, en-GB) lacks most keys: a locale script must skip files without the key, not assert.
