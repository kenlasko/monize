# Accrual accounting integration plan

The feature contract is `docs/specs/accrual-accounting.md`. Tasks are in `docs/future-plans/accrual-accounting-tasks.md`.

## Assumptions

Port the existing local accrual implementation onto current upstream `main`, independently of the earlier SimpleFIN branch. Preserve current upstream warranty, import, reporting, cache, reconciliation and delegation behavior. The feature is published for review as upstream PR #1883. Production deployment remains outside this preparation task.

## Integration areas

1. Database: schedule, allocation and system-account persistence, paired schema/migrations and RLS policies.
2. Backend: reviewed commands, source lifecycle, split/bulk/history integration, import protections, backup/export classification and effective-date reporting facts.
3. Reporting: selectable income/expense recognition, budget actuals, category/payee trends, dashboards, tools and exports; explicit cash semantics for payment-specific surfaces.
4. Frontend: an embedded editor tab, server-generated preview, one save, parent navigation, user-default basis toggle and read-only system accounts under Other.
5. Review: localized catalogs, regression coverage, source inventory, invariant IDs and honest contribution checklist.

## Checks and observations

Follow `AGENTS.md` and each layer's index. Run backend lint, both backend type checks, changed tests, build and serial PostgreSQL integration tests. Run frontend lint, types, locale/pseudo checks, changed tests and build. Run migration lint, schema replay, migration-prefix, environment documentation and document-manifest checks. Stage new files before guards. Do not weaken guards, thresholds or allowlists.

Expected observations: one original cash payment, exactly conserved monthly allocations on month-end or the selected first-business-day rule, stable bank balances, rejected stale reviews leaving stored state unchanged, no cross-owner data, and identical selected-basis amounts across supported display and export surfaces. Keep test evidence outside the product source and state any failures before requesting review.

## Concurrency

Accrual writers use the lock scopes in `backend/src/common/db/locks.ts`, source locks and the caller's `withScopedDb` transaction. Bulk history serializes by user before taking source rows; schedule revisions and fingerprints detect stale commands. This records the relevant accrual concern without restoring the upstream-retired horizontal-scaling plan.

## Contribution boundary

Supply the approving discussion link and maintainer assignment before publishing. The upstream contribution process may require a smaller review series; this local branch preserves the full feature for that decision. Include AI assistance disclosure and verify each PR checklist statement instead of pre-checking it.
