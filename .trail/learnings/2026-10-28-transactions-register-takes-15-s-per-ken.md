---
title: Transactions register takes ~15 s per account switch because Postgres JIT-compiles the RLS-inflated count query
author: Ken
date: 2026-10-28
branch: feat/shared-expenses
id: l-71860711
scope: repo
status: active
src: agent
touches:
  - backend/src/transactions/transactions.service.ts
  - backend/src/common/db/scoped-db.ts
---

## Decided
- Cause found, not yet fixed: the register's `getManyAndCount` count query (COUNT(DISTINCT transaction.id) over the 17 joins in `registerRowsQuery`) gets a planner cost of ~720k for an 806-row account, because every joined table's RLS policy adds delegate-read subplans. That is above `jit_inline_above_cost` / `jit_optimize_above_cost` (500k defaults), so Postgres JIT-compiles ~2,700 functions with inlining and optimisation on every call: ~14.8 s of pure CPU. Real execution is ~22 ms with `SET LOCAL jit = off`, ~12 ms without RLS.
- Not caused by any one branch: the joins date from Feb 2026 and the delegate RLS arms from Jul/Aug 2026; nothing in the repo (compose, helm, schema, withScopedDb) configures `jit`, so the stock `jit = on` applies everywhere.
## Tried and ruled out
- Slow plan nodes, I/O, missing indexes: the plan touches ~2,800 shared buffers, all hits, and no node accounts for the time. The 15 s shows up as the startup time of the first leaf scan, which is what JIT compile looks like in EXPLAIN ANALYZE with TIMING on. EXPLAIN (ANALYZE) with costs shows the `JIT: Functions: 2693, Inlining true, Optimization true` block.
## Watch out
- Reproduce as the app role with the GUCs set, or RLS (and so the cost blow-up) disappears: `SET LOCAL ROLE monize_app; set_config('app.current_user_id', <id>, true); set_config('app.real_user_id', <id>, true)`.
- `investment_transactions.transaction_split_id` is the FK for the split's investment join; there is no `transaction_splits.investment_transaction_id`.
- Candidate fixes (none applied): `jit = off` for the app role/database or via connection options; or a lighter count query that joins only the aliases a filter references.
In the code: backend/src/transactions/transactions.service.ts (findAll, registerRowsQuery), backend/src/common/db/scoped-db.ts.
