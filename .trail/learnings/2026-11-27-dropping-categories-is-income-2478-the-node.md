---
title: "Dropping categories.is_income (#2478): the rollout ordering blocks a one-PR drop"
author: Node
date: 2026-11-27
branch: claude/issue-2478
cost: { minutes: 3, tokens: 104044 }
touches:
  - docs/database-migrations.md
  - package.json
---

## Decided
- Asked the maintainer before editing anything: the 1.22.0 Category entity still maps `is_income` (category.entity.ts, `@Column({ name: "is_income" })`) and the service writes it via `incomeFlagOfType`, so any release that drops the column breaks the previous release's pods for the length of the rollout (the A26-L09 case in docs/database-migrations.md). `contract-after: X` is only true for an X that no longer maps the column.
- Recommended: unmap the entity in 1.22.0 (main was still pre-1.22.0: package.json 1.21.0, no v1.22.0 tag), then drop column + mirror + API `isIncome` in 1.23.0 with `contract-after: 1.22.0`. The mortgage-flags precedent (20261003152748 / 20261113022314) is the same two-step.
- `trg_categories_sync_type` does three jobs: the is_income mirror, a child's type from its parent, and the held-by-a-category-row refusal. Only the mirror goes; keep the other two.

## Tried and ruled out
- A generated `is_income` column to keep old pods reading: TypeORM inserts explicit values, which a generated column refuses.
- Removing the API `isIncome` in the same release as the expand: a 1.21.x frontend reads it, so it stays on the wire for one release (spec decision 9).

## Watch out
- `isIncome` appears in about 90 frontend files and many backend ones, and most of them mean something else: budget lines (`budget_categories.is_income` stays), Monthly Breakdown sections, bill reminders, forecast, quick-add, importer category definitions. Only the category wire shape, the entity and the `CategoryTypeSource` fallback belong to this issue.
- Old backups and undo snapshots carry `is_income` without `category_type`. Restore drops unknown columns, so income categories would come back as Expense. They need a mapping like `withResolvedMortgageTypeColumn` (backup-restore-database.service.ts) and the same in action-history `ALLOWED_COLUMNS` / reinsertEntity.
- Also to touch: support-backup-rules.ts, test/integration/fixtures/schema-baseline.sql, INV-CATEGORY-003, spec section 17.3.
