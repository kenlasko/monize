---
title: "All database migrations are kept; there is no minimum upgrade version, because they cost about 2 s on a first start"
author: Ken
date: 2026-11-14
branch: feat/desktop-integration
id: l-a6579133
scope: repo
status: active
src: agent
touches:
  - backend/src/db-init.ts
  - backend/src/db-migrate.ts
  - scripts/verify-schema.sh
---

## Decided
- Ken chose (2026-11-14) to keep every migration and set no minimum upgrade version.
- Why: on an empty database, db-init loads schema.sql and db-migrate then replays all migrations as no-ops, which took 2.1 s for 271 on the Windows CI runner (0.3 s on later starts). The slow desktop first start was the backend's cold module load, not migrations.

## Tried and ruled out
- Deleting migrations before a cut-off release behind an "upgrade to vX first" check: real installs' versions are unknown (GHCR pulls give no per-client data), merged migrations are not to be changed casually, and the tracker, the prefix check and verify-schema assume the full set.
- Marking migrations as applied without running them on a fresh database: safe, but only saves about 2 s; not done.

In the code:
- backend/src/db-init.ts, backend/src/db-migrate.ts, database/migrations/, scripts/verify-schema.sh
