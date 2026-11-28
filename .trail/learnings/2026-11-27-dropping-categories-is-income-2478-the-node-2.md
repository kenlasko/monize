---
title: "Dropping categories.is_income (#2478): the contract migration, the fallback removal and the fixture sweep"
author: Node
date: 2026-11-27
branch: claude/issue-2478
cost: { minutes: 69, tokens: 352243 }
touches:
  - backend/src/categories/legacy-income-flag.util.spec.ts
  - backend/src/categories/legacy-income-flag.util.ts
  - database/migrations/20261127205950_categories_drop_is_income.sql
  - docs/backend/transactions-and-money.md
  - docs/financial-semantics.md
  - docs/frontend/financial-figures.md
  - docs/frontend/ui-conventions.md
  - docs/specs/transfer-categories.md
  - e2e/docs-screenshots/taxes.spec.ts
  - e2e/helpers/factories.ts
---

## Decided
- The maintainer chose to drop in one PR (`contract-after: 1.22.0`), accepting that the previous release's pods break during the rollout. The migration comment says so.
- `trg_categories_sync_type` keeps its name. Only the mirror branches go; the child-inherits-parent and held-to-Transfer refusals stay. The new migration replaces the function before `DROP COLUMN`, and its body must match `schema.sql` byte for byte for `verify-schema.sh`.
- The merged `20261126214741` backfill is wrapped in an information_schema check (the mortgage-flags precedent, deb9c885e). Without it a fresh install and the integration harness fail on `is_income`, because the harness builds the schema with `synchronize` and replays every migration matching `RETURNS TRIGGER`.
- `CategoryTypeSource.categoryType` is now required on both layers, so tsc lists every caller that leaned on the flag fallback. `categoryTypeOrUndefined` takes an optional type.
- Old backups and undo snapshots go through `categories/legacy-income-flag.util.ts`. It sets the type from the flag and drops a null type, because `category_type` is NOT NULL.

## Tried and ruled out
- Converting every `isIncome` in test files: budget lines, Monthly Breakdown sections, forecast rows and import definitions use the same name with other meanings. Only convert lines tsc flags, plus files known to hold category-only fixtures.

## Watch out
- Untyped fixtures (`as any`, plain objects passed to mocks) that state the type only through `isIncome` pass tsc but now read as no type. Run the related suites (backend `--findRelatedTests` on the files using the type helpers, frontend `vitest related`) and fix what fails: transaction-analytics, forecast-aggregator, financial-context, the categories page, SplitEditor, bills-filters, useTransactionFilters.
- A frontend `categoryType: 'expense'` inside an inline object that is later spread widens to string; add `as const`.
- e2e `createCategory` and the README seed POSTed `isIncome`; with `forbidNonWhitelisted` that is now a 400.
