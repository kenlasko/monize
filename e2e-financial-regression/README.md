# Monize financial regression harness (manual, local-only, read-only)

> **STOP AND READ THIS FIRST.**
>
> This directory is **not** the CI end-to-end suite (`../e2e`). It is a
> **manual, developer-run** tool that drives a **real, existing Monize
> database** through the browser to prove that a code change did **not**
> silently alter any financial figure a user can see.
>
> - It is **NOT** wired into CI, GitHub Actions, pre-commit hooks, or
>   `npm test`. It must never be. See [Why this is not in CI](#why-this-is-not-in-ci).
> - It is **strictly read-only**. It never creates, edits, deletes, imports,
>   refreshes, reconciles, or otherwise mutates **user data**. A machine-checked
>   guard aborts the run if the app ever attempts a data-mutating request
>   (see [The read-only guarantee](#the-read-only-guarantee)).
> - It requires an **explicitly configured** database and application
>   environment (`regression.env`). It refuses to run against an unconfigured
>   or unsafe-looking environment, and fails loudly.

## What it is for

This harness exists for one specific kind of change: a change that is
**supposed to leave every normal financial value exactly as it was**, while
fixing behaviour only in exceptional, incomplete-data cases.

The concrete motivating change is the **"unknown is not zero"** work
(branch `pr/06-unknown-is-not-zero`, tracked as PR #1145). Its contract
(`docs/financial-calculation-contract.md`) says a total, portfolio value,
allocation, gain, or tax figure may only carry a value when **every**
component is known; a missing price, missing exchange rate, or failed
valuation must render as **unknown**, never as a misleading `0`.

So there are two obligations, and this harness has one suite for each:

1. **Complete data must be untouched.** For accounts, dashboards,
   transactions, bills/cash-flow, investment allocations, and the affected
   reports, every headline financial value must be **identical** BEFORE and
   AFTER the change. -> `tests/capture.spec.ts` + the comparison report.
2. **Incomplete data must stop lying.** Where a price/FX/valuation is
   missing, the value must switch from a wrong `0` to an explicit unknown.
   These cases are driven with **Playwright request routing** (network
   interception) and never touch the database. -> `tests/exceptional-missing-fx.spec.ts`.

The two are kept deliberately separate: suite 1 asserts *sameness*, suite 2
asserts *intended difference*. Mixing them would make "nothing changed" and
"the right thing changed" indistinguishable.

## How the comparison works (sequential, never concurrent)

The BEFORE and AFTER revisions of the app are run **one at a time against the
same database**, never concurrently:

```
   preflight safety checks
        |
   start BEFORE revision  ->  capture financial values  ->  artifacts/before.json
        |
   stop BEFORE revision                (app down; DB untouched)
        |
   start AFTER revision   ->  capture the same values    ->  artifacts/after.json
        |
   stop AFTER revision
        |
   compare before.json vs after.json  ->  report + pass/fail exit code
```

Running them sequentially is a hard requirement, not a convenience: two app
revisions writing to one database at once could corrupt it, and the "unknown
is not zero" change may ship a forward schema migration. **BEFORE always runs
first** so the schema only ever moves forward. See
[Database safety](#database-safety).

## Prerequisites

- Docker + Docker Compose (the harness builds and runs each revision in
  containers, the same way `docker-compose.e2e.yml` does).
- Node.js 20+ and `npm`.
- Playwright browsers: `npm install && npx playwright install chromium`.
- **A disposable copy of a real Monize database** you are willing to point a
  browser at (see the strong recommendation in [Database safety](#database-safety)).
- **Login credentials for an existing user** in that database. The harness
  logs in as that user through the UI and reads what they see. It never
  registers or seeds anything.

## Configure the environment

```bash
cp regression.env.example regression.env
# then edit regression.env
```

`regression.env` is git-ignored and **required** -- the harness refuses to run
without it. Every field is documented inline in the example file. The
essentials:

| Variable | Meaning |
|---|---|
| `MONIZE_BEFORE_REF` | git ref (tag/branch/SHA) of the BEFORE revision, e.g. `main` |
| `MONIZE_AFTER_REF` | git ref of the AFTER revision, e.g. `pr/06-unknown-is-not-zero` |
| `MONIZE_DB_HOST` / `_PORT` / `_NAME` / `_USER` / `_PASSWORD` | the **external, pre-existing** database to read |
| `MONIZE_USER_EMAIL` / `MONIZE_USER_PASSWORD` | an existing user's login |
| `MONIZE_USER_TOTP_SECRET` | *(optional)* that user's TOTP secret, if 2FA is on |
| `I_UNDERSTAND_THIS_IS_READ_ONLY_ON_A_DISPOSABLE_DB` | must be `yes` -- the explicit safety acknowledgement |

## Run it

```bash
npm install                 # first time only
npx playwright install chromium
npm run compare             # the whole BEFORE/AFTER/report flow
```

`npm run compare` runs `scripts/run-comparison.mjs`, which performs the
preflight, orchestrates both revisions, and prints the comparison report. It
exits non-zero (loudly) if:

- the environment is missing or looks unsafe;
- either revision fails to build or start;
- any complete-data value differs between BEFORE and AFTER.

Other scripts:

| Command | What it does |
|---|---|
| `npm run compare` | full sequential BEFORE/AFTER run + report |
| `npm run preflight` | only the safety checks (does not start anything) |
| `npm run report` | re-render the report from existing `artifacts/{before,after}.json` |
| `npm run test:exceptional` | run the missing-FX / failed-valuation suite (single revision, no DB writes) |

If you prefer to manage the app lifecycle yourself, you can run each phase
against an already-running URL -- see
[Manual / URL mode](#manual--url-mode-no-docker-orchestration).

## The read-only guarantee

Being careful is not enough; the guarantee is enforced by code.

`src/readonly-guard.ts` installs a Playwright route handler on every page. It
lets through:

- all navigations and asset/`GET`/`HEAD` requests;
- the small, explicit allowlist required merely to **log in and stay logged
  in** (`POST /auth/login`, the CSRF token fetch, 2FA verification, token
  refresh, logout).

It **aborts and records** any other `POST`/`PUT`/`PATCH`/`DELETE` to the API.
If the app under test ever tries to write user data during a capture, the
request is blocked and the run **fails loudly** with the offending method and
URL. That turns "the tests are read-only" from a promise into a check.

The capture suite additionally only ever *navigates and reads*: it opens a
route, waits for values to render, and extracts text. It clicks nothing that
submits, and never fills a form.

## Database safety

**Point this at a disposable copy of your data, not at your live database.**

- Restore a backup / snapshot into a throwaway database and set
  `MONIZE_DB_*` to that copy. The org's data-handling guidance is to work on
  masked or copied data rather than production; this harness assumes you have.
- The harness treats the database as **external and pre-existing**. It never
  creates, drops, resets, seeds, or truncates it, and the compose file it uses
  (`docker-compose.regression.yml`) contains **no `postgres` service** -- there
  is nothing for the harness to accidentally wipe.
- The **application itself** still runs its normal boot steps, which include
  `db-migrate`. The AFTER revision may therefore apply a forward schema
  migration to your copy. This is why BEFORE runs first and why a disposable
  copy matters: the schema only moves forward, and you throw the copy away
  afterwards.
- The preflight refuses to run unless
  `I_UNDERSTAND_THIS_IS_READ_ONLY_ON_A_DISPOSABLE_DB=yes`, and warns hard if
  the database name or host looks like production (`prod`, `production`, a
  non-local host without `MONIZE_ALLOW_REMOTE_DB=yes`).

## Manual / URL mode (no Docker orchestration)

If you would rather start each revision yourself (e.g. you already have the
two builds running, or you cannot build in Docker), set `MONIZE_BEFORE_URL`
and `MONIZE_AFTER_URL` in `regression.env` and run the phases directly:

```bash
# 1. Start the BEFORE revision yourself, pointed at the copy DB.
BASE_URL="$MONIZE_BEFORE_URL" REGRESSION_PHASE=before npx playwright test capture
# 2. Stop it. Start the AFTER revision against the SAME DB.
BASE_URL="$MONIZE_AFTER_URL" REGRESSION_PHASE=after npx playwright test capture
# 3. Compare.
npm run report
```

The harness still enforces sequential capture (each phase writes its own JSON)
and still installs the read-only guard.

## Why this is not in CI

- It needs a **real database with real balances**; CI starts from an empty one,
  so there would be nothing to compare and every value would be a trivial zero.
- It runs **two full application builds** and boots them in turn -- minutes of
  wall-clock, not the fast honest signal CI wants.
- It is a **release-time / review-time confidence check** a developer runs
  deliberately, reads the report, and makes a judgement on -- not a gate that
  blocks a merge.

Keep it out of `../e2e`, out of `playwright.config.ts` at the repo root, out
of `.husky`, and out of any workflow under `.github/`.

## Files

| Path | Role |
|---|---|
| `src/signals.ts` | the catalogue of every (screen, field) financial value captured |
| `src/capture.ts` | read-only navigation + value extraction engine |
| `src/readonly-guard.ts` | Playwright route guard that blocks data-mutating requests |
| `src/money.ts` | monetary-text normalization + known-zero vs unknown detection |
| `src/auth.ts` | UI login with existing credentials (+ optional TOTP) |
| `tests/capture.spec.ts` | captures all signals for the current revision into JSON |
| `tests/exceptional-missing-fx.spec.ts` | separate missing-FX / failed-valuation suite (request routing) |
| `scripts/run-comparison.mjs` | orchestrator: preflight -> BEFORE -> AFTER -> report |
| `scripts/preflight.mjs` | environment safety checks |
| `scripts/compare.mjs` | build the comparison report and pass/fail |
| `docker-compose.regression.yml` | app-only stack that points at your external copy DB |
| `regression.env.example` | annotated configuration template |
