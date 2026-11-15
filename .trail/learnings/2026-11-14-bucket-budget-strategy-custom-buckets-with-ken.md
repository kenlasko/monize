---
title: "Bucket budget strategy: custom buckets with presets, percent-or-amount targets, per-bucket carry-over, 50/30/20 left alone"
author: Ken
date: 2026-11-14
branch: feat/bucket-budget
cost: { minutes: 24, tokens: 103774 }
id: l-7c16ca69
scope: repo
status: active
src: agent
touches:
  - backend/src/backup/backup-format.ts
  - backend/src/backup/export-table-queries.ts
  - backend/src/backup/restore-plan.ts
  - backend/src/backup/restore-references.ts
  - backend/src/backup/restore-wipe.ts
  - backend/src/backup/support-backup/support-backup-integrity.ts
  - backend/src/backup/support-backup/support-backup-rules.budgets.ts
  - backend/src/backup/support-backup/support-backup-rules.ts
  - backend/src/backup/support-backup/support-backup-sections.ts
  - backend/src/budgets/budget-activity-reports.service.spec.ts
---

## Decided
- The fifth budget strategy is user-defined buckets per budget, with editable presets (three buckets, four buckets 60/10/10/20, blank).
- A bucket target is a percent of income or a fixed amount per period; both kinds can sit in one budget.
- Carry-over is a per-bucket option with an optional cap; an overspent bucket carries zero.
- 50/30/20 keeps its own column and widget; no existing budget is migrated.
- Bucket figures are computed once on the server and frozen at the period close.

## Tried and ruled out
- A fixed three-bucket set (Fixed/Variable/Savings): too close to 50/30/20 and not renameable.
- Account-based buckets (one bank account per bucket, tracking funding transfers): a different feature; out of scope.
- Rebuilding 50/30/20 on top of buckets: needs a data migration of live budgets for no user-visible gain.
- Bucket-level alerts in v1: need a new notification type and another key in the notifications fingerprint unique index; separate proposal.

## Watch out
- "bucket" in the budgets module already means a time bucket (queryCategorySpendingBuckets); new symbols are BudgetBucket / budget_bucket.
- UNIQUE(budget_period_id, bucket_id) allows several rows with a null bucket_id once buckets are deleted; an upsert must not rely on it for a deleted bucket.

In the code:
- Plan: docs/future-plans/bucket-budget.md and bucket-budget-tasks.md; branch feat/bucket-budget.
- Tables: budget_buckets, budget_period_buckets; column budget_categories.bucket_id.
