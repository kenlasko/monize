---
title: "Transfer categories PR 2: the category type end to end (#2453)"
author: Node
date: 2026-11-27
branch: claude/issue-2453
cost: { minutes: 116, tokens: 820995 }
touches:
  - docs/future-plans/transfer-categories-tasks.md
  - backend/src/categories/categories.service.spec.ts
  - backend/src/categories/categories.service.ts
  - backend/src/categories/country-category-additions.ts
  - backend/src/categories/default-categories.spec.ts
  - backend/src/categories/default-categories.ts
  - backend/src/i18n/locales/de/categories.json
  - backend/src/i18n/locales/en/categories.json
  - backend/src/i18n/locales/es/categories.json
  - backend/src/i18n/locales/fr/categories.json
---

## Decided
- `categories.category_type` is the truth; `is_income` stays mapped on the entity and a trigger mirrors it both ways, so API shape and old pods keep working. App code reads the type only through `backend/src/categories/category-type.util.ts` and `frontend/src/lib/category-type.ts`; `categoryTypeOf` falls back to the legacy flag so existing fixtures need no change.
- The READ guard (backend spec and frontend test) is name-based: it flags raw `is_income` SQL, quoted `"isIncome"` selects, negated reads, and reads on category-named receivers. `src/budgets/` is exempt for receiver rules because budget lines have their own `isIncome`. A line with a reason carries `income-flag-ok: <reason>`; there is no file allowlist.
- Settings that copy a category onto a row (payee default, asset category, loan interest and fee, payroll rule) refuse a Transfer category through `categories/category-fit.ts`. A stored one is skipped where applied through `category-row-gate.ts` and the payee lookup.
- New locale keys are copied as English into every full locale (scripted) so the parity specs stay green. PR 5 translates them.

## Tried and ruled out
- Removing `isIncome` from the entity or making it a getter: it breaks nested serialization and hundreds of spec fixtures.
- A type-aware guard over the whole program: too heavy for a Jest spec.
- Adding a row to `backend/CLAUDE.md`: it is 12 bytes under its ceiling. The rule went in `docs/backend/transactions-and-money.md`.

## Watch out
- The integration harness only gets the triggers from migrations containing `RETURNS TRIGGER`. A spec that builds its own TypeORM module (`mny-import.integration`) has no mirror, so assert `categoryType` there, not `isIncome`.
- Every mock manager that runs the shared lock needs `query`. `locksMockModule` now carries the two new lock helpers.
- Never name `category_held_by_category_row` or the fit function in `src/` comments: `required-db-functions.spec` flags it.
- Frontend `npm run test:changed` takes about 35 minutes and ran out of memory (137) on the re-run. Two files failed and I never saw which.
