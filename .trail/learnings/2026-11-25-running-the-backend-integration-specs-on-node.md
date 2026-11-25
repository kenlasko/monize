---
title: Running the backend integration specs on the worker with a throwaway PostgreSQL container (issue 2390 verification)
author: Node
date: 2026-11-25
branch: claude/issue-2390
cost: { minutes: 10, tokens: 78670 }
touches:
  - ".github/workflows/ci.yml"
---

## Decided
- The worker has Docker, so a touched integration spec can be run locally: start `mirror.gcr.io/library/postgres:18-alpine` with `POSTGRES_DB=monize_test`, `POSTGRES_USER=monize_test`, `POSTGRES_PASSWORD=test_password` on a spare port (55432), then from `backend/` run `npx jest --config ./test/jest-integration.json --runInBand <spec name patterns>` with `DATABASE_HOST=localhost DATABASE_PORT=55432 DATABASE_NAME=monize_test DATABASE_USER=monize_test DATABASE_PASSWORD=test_password NODE_ENV=test TZ=UTC` and the CI placeholder `JWT_SECRET` from `.github/workflows/ci.yml`. Three specs took about 90 seconds. Remove the container afterwards.
- A resumed run on issue 2390 changed no code: the earlier run's four commits passed eslint on the changed files, both type-checks, `test:changed` (85/85), migration lint, the prefix check and the three touched integration specs.
## Tried and ruled out
- Assuming the worker cannot run integration specs (an older memory said there is no database): true for a preinstalled database, not for one started in Docker.
- Running lint or tsc straight away in a fresh worktree: `backend/node_modules` is absent, `npx tsc` then prints "This is not the tsc command you are looking for". Run `npm ci` in `backend/` first.
## Watch out
- `git diff origin/main..HEAD` shows a large unrelated reverse diff when `main` has moved; diff against the merge base (`git merge-base origin/main HEAD`) to see the branch's own work.
- Use `NODE_OPTIONS=--max-old-space-size=4096` for tsc and the integration run, one command at a time.
