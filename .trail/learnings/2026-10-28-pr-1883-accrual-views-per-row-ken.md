---
title: "PR 1883 accrual views: per-row cash-id function makes accrual reads take seconds to minutes on Postgres 16"
author: Ken
date: 2026-10-28
branch: main
id: l-94b37c3a
scope: repo
status: active
src: agent
---

## Decided
- Benchmarked the redesigned read model (views accrual_reporting_*, migration 20261027213808) on a throwaway postgres:16-alpine container loaded with the PR's schema.sql plus a synthetic ledger (41k transactions per user, 8k transfer legs, 3k splits, 50-500 schedules), under RLS as a non-bypass role. The local dev DB is empty, so a synthetic seed is the only option.
## Watch out
- `accrual_reporting_cash_id()` is called per row for parent_transaction_id / linked_transaction_id in the transactions, splits and investment views. It has `SET search_path` and a FROM clause, so it is never inlined, and on PG16 a non-inlined SQL function re-plans on every call (about 16 ms with the RLS policies). Measured: reading linked_transaction_id for 8k transfers took 128 s. A `parent_transaction_id IS NULL` filter (spending, income and monthly-breakdown reports, plus the register) with 500 split-transfer children took 8 s vs 18 ms cash. Hydrating a 50-row register page took 0.4 s vs 8 ms. With `IN (subquery)` instead of a literal list, hydration ran past 60 s because the target list is computed before the semi-join.
- Every view query also plans in about 100 ms (a 700-line plan from nested RLS policy subplans), and ORDER BY date LIMIT can no longer use idx_transactions_user_date_created: the whole UNION is materialized and sorted.
- Execution only switches to the views when accrual_enabled is true and the user has at least one schedule, so cash users never touch them. Cash users still pay for the other changes (per-row GROUP BY t.id money sums, the full exchange_rates load, FOR UPDATE on the whole ledger during import).
In the code: database/migrations/20261027213808_accrual_explicit_reporting_views.sql, backend/src/accruals/reporting-basis.ts (resolveReportingExecution).
