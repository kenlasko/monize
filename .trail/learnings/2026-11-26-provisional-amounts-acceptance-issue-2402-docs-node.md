---
title: "Provisional amounts acceptance (issue 2402): docs, invariants, plan retired"
author: Node
date: 2026-11-26
branch: claude/issue-2402
cost: { minutes: 5, tokens: 140619 }
touches:
  - backend/src/accounts/account-balances-report.service.ts
  - backend/src/accounts/accounts.service.ts
  - backend/src/accounts/daily-balance-totals.service.ts
  - backend/src/action-history/action-history.service.ts
  - backend/src/backup/restore-legacy-normalizations.ts
  - backend/src/budgets/budget-spending.util.ts
  - backend/src/common/ledger-balance-sql.spec.ts
  - backend/src/common/ledger-balance.sql.ts
  - backend/src/common/provisional-count.util.ts
  - backend/src/import/import-regular-processor.service.spec.ts
---

## Decided
- Locales needed no new commit: earlier sub-issues translated every provisional key; a missing-key script over both layers found nothing.
- Release note goes in a new docs/release-notes/1.22.0.md (1.21.0 is already released).
- P2, P3, P5, P6, P7 became INV-FX-007 to INV-FX-011; P4 stays in INV-FX-002. P5 is partial (no guard finds a surface that omits the count).
- Plan retired by moving the design to docs/specs/provisional-amounts.md, folding the task list into its section 14 and deleting the tasks file.
- Repeat strip migration 20261126180000_..._repeat.sql, never a repeat of the flag backfill.

## Tried and ruled out
- Leaving merged migrations alone: source-comment-paths.spec.ts fails on a moved doc path in a `--` comment. The runner has no content checksum, so only the comment lines were edited; COMMENT ON strings and schema.sql were left.

## Watch out
- A sed over the repo for the old path also edits the tasks file you then want to delete: use git rm -f.
- The worktree has no node_modules; `npm ci --ignore-scripts` in frontend/ and backend/ takes about 30s each, and docs:build needs it.
- Close the tracker and comment on Discussion 2383 on GitHub; the worker cannot.
