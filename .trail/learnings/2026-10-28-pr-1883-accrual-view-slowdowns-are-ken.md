---
title: PR 1883 accrual view slowdowns are severe only under RLS enforce; with RLS off they are 2 to 10 times slower than cash
author: Ken
date: 2026-10-28
branch: feat/accrual-accounting
id: l-04b1dd17
scope: repo
status: active
src: agent
touches:
  - backend/src/common/db/app-role.ts
---

## Decided
- The per-row cash-id function cost recorded in the two earlier PR 1883 learnings was measured as a role with RLS enforced. Re-measured on the dev DB copy with 50 schedules: as the owner (RLS_MODE=off, the default, which bypasses policies) reading linked_transaction_id for 6k transfers took 0.85 s; with RLS enforced it took 71 s. The investment view took 0.74 s vs 57-66 s. The summary-shaped query took 158 ms vs over 2 minutes (cancelled). Register queries took 25-45 ms vs 70-490 ms.
- Why: a non-inlined SQL function on PG16 re-plans on every call. Under enforce, each plan expands the nested accrual and transaction policies plus the delegate-grant subplans, which costs about 10 ms per call instead of about 0.1 ms.
## Watch out
- Before claiming a slowdown, check RLS_MODE: a default install sees modest regressions, and an enforce install sees requests that never finish. To test enforce on dev, create monize_app with db-init's own SQL (backend/src/common/db/app-role.ts) using DATABASE_APP_PASSWORD from .env, and recreate the backend container so it picks up the env.
