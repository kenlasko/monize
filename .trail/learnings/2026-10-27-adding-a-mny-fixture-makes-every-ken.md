---
title: "Adding a .mny fixture makes every fixture-wide evidence test check it too, so a new Money version breaks Money Plus assumptions in the tests"
author: Ken
date: 2026-10-27
branch: feat/mny-money99-import
id: l-829ab4f8
scope: repo
status: active
src: agent
touches:
  - backend/src/i18n/locales/en/errors.json
  - backend/src/i18n/locales/xx/errors.json
  - backend/src/import/mny/README.md
  - backend/src/import/mny/__fixtures__/README.md
  - backend/src/import/mny/__fixtures__/fake-mny-database.ts
  - backend/src/import/mny/__fixtures__/mny-fixtures.ts
  - backend/src/import/mny/__fixtures__/mny-row-builders.ts
  - backend/src/import/mny/__fixtures__/sample-money99.mny
  - backend/src/import/mny/map/map-bills.ts
  - backend/src/import/mny/map/map-investments.spec.ts
---

## Watch out
- A new `.mny` fixture is picked up by every spec that loops over all fixtures, and some of those loops assert Money Plus facts, not format rules. Adding the Money 99 file broke three: a per-fixture record of missing columns (a type error, only `npm run typecheck` reports it, not the jest run), a currency-count threshold (over 40; Money 99 quotes 24), and an income-root check by the English name "INCOME" (the Money 99 file is Spanish, "INGRESOS"). The rules held on the new file; only the tests' assumptions did not. Check the rule against the file before changing a threshold.
- `*.mny` is gitignored except `sample*.mny`; name a new fixture `sample-*.mny` rather than editing `.gitignore`.

In the code: `backend/src/import/mny/tables/read-mny-tables.spec.ts` (`EXPECTED_MISSING_FIELDS`), `backend/src/import/mny/model/mny-model.spec.ts` (currency pseudo-securities, `isIncomeCategoryType`), `backend/src/import/mny/__fixtures__/mny-fixtures.ts`.
