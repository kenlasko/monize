---
title: "Mortgage-type contract (P3-B2): NOT NULL, flags dropped, replay guards on merged migrations"
author: Node
date: 2026-11-13
branch: claude/issue-1841
cost: { minutes: 39, tokens: 198491 }
touches:
  - backend/test/integration/mortgage-type-backfill.integration.spec.ts
  - docs/backup-restore-contract.md
  - docs/financial-semantics.md
  - docs/future-plans/mortgage-types-tasks.md
  - docs/future-plans/mortgage-types.md
  - docs/specs/mortgage-types.md
  - docs/system-invariants.md
  - frontend/src/lib/mortgage-type.test.ts
  - frontend/src/lib/mortgage-type.ts
  - frontend/src/types/account.ts
---

## Decided
- Contract migration 20261113022314_accounts_mortgage_type_contract.sql (`-- contract-after: 1.20.0`): guarded flag backfill for a 1.19.x-rollback null, null -> ANNUITY, SET NOT NULL, DROP COLUMN IF EXISTS both flags.
- Fresh-install replay solved by option (a) of #1841: BOTH merged migrations that read the flags (20261002151116 and 20261003152748; the issue named only the first) wrap their flag UPDATE in the 110_ information_schema guard. Filenames unchanged.
- legacy-mortgage-type.util.ts stays: old backups and undo snapshots still carry the flags. Specs that feed it old snapshots legitimately name the flags too.

## Tried and ruled out
- Routing LoanPaymentSetupDialog's `loanAccount.mortgageType ?? 'ANNUITY'` through mortgageTypeOf: that prop is optional on purpose (import flow), so the fallback is a real default; nine dialog tests fail without it.

## Watch out
- accounts_payment_amount_method_check still has a dead `OR mortgage_type IS NULL` branch; dropping it means redefining the constraint in a migration.
- Integration specs run fine against a throwaway `mirror.gcr.io/library/postgres:16-alpine` container on port 54329, with Jest called directly (`--config ./test/jest-e2e.json --testPathPatterns=... --runInBand`).
