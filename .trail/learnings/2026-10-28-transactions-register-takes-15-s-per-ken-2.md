---
title: "Transactions register takes ~15 s per account switch on the dev stack only, because dev Postgres JIT-compiles the RLS-inflated count query"
author: Ken
date: 2026-10-28
branch: feat/shared-expenses
id: l-fb21e6a3
scope: repo
status: active
replaces: l-71860711
src: agent
touches:
  - backend/src/transactions/transactions.service.ts
  - docker-compose.dev.yml
---

## Decided
- Cause: the register's `getManyAndCount` count (COUNT(DISTINCT transaction.id) over the 17 joins in `registerRowsQuery`) plans at ~720k cost because each joined table's RLS policy adds delegate-read subplans. That is above the 500k JIT inline/optimise thresholds, so Postgres compiles ~2,700 functions per call: ~15 s CPU. With `SET LOCAL jit = off` it runs in ~22 ms.
- Dev only: docker-compose's `postgres:16-alpine` ships llvmjit. Production (CNPG `postgresql:18.x-minimal-trixie`) has `jit = on` but `pg_jit_available()` = false, because the minimal image has no LLVM JIT library, so it never compiles.
## Watch out
- Switching prod to the CNPG standard image (which adds JIT) would bring the 15 s stall to production; set `jit = off` for the app role first.
- Reproduce as `monize_app` with `app.current_user_id` / `app.real_user_id` set; as superuser RLS vanishes and so does the cost blow-up.
In the code: backend/src/transactions/transactions.service.ts (findAll, registerRowsQuery); docker-compose.dev.yml (postgres image).
