# Shared expenses UI review: task list

Plan: `docs/future-plans/shared-expenses-ui-polish.md`.
Specification: `docs/specs/shared-expenses-ui-polish.md`.

## Current scope

- [x] Recheck edited PR comments as well as new Discussion/issue replies.
- [x] Identify the newly added restriction on accounts and possible deferral of
  core integrations; record the narrower proposal in specification section 0.
- [x] Retain the original approval and subsequent scope correction as history.
- [x] Requester approves the narrower boundary; revise the plan and acceptance
  matrix. New private posting, matching and private FX redesign are deferred.

## Approval and preparation

- [x] Read the current Discussion, issue, PR comments, reviews and inline comments.
- [x] Pin Ken's review and the published revision; inspect affected feature code.
- [x] Identify the existing Transactions controls and the FX/category conflict.
- [x] Prepare a proposal covering UI-01 through UI-11 and numerical examples.
- [x] Requester approves the spec, including section 5's proposed FX policy.
- [x] Recheck branch state, fast-forward while preserving Ken's merge, and commit
  the earlier approved spec before its implementation (`69734062d`).
- [x] Read in full the relevant layer/contract documents before code changes;
  analysis excerpts do not satisfy that implementation precondition.

## Implementation

- [x] Block new private-finance commands at the server, with HTTP regressions;
  retain existing reads/unlink and their ownership checks.
- [x] Remove creation/handoff controls and handle old URLs; retain access to
  already-created private records.
- [x] UI-01/UI-04: staged attachments, successful close, in-place retry and no
  redundant item/amount subheading.
- [x] UI-02/UI-05: group and expense tables, standard filter presentation,
  accessible rows, server paging and phone layouts.
- [x] UI-03: standard currency square and input; retain precision and group FX.
- [x] Document corrected conventions with regressions, without baseline growth.

## Verification and publication

- [x] Run focused regressions during development; demonstrate the original
  failure for changed behavior where feasible.
- [x] Frontend gate: `npm run lint`, `npm run type-check`, `npm run i18n:check`,
  `npm run test:changed`, production build.
- [x] Backend gate: `npm run lint`, `npx tsc --noEmit`, `npm run typecheck`,
  `npm run test:changed`, `npm run build`, `npm run test:integration`.
- [x] Root checks: `node scripts/check-env-docs.mjs` and
  `node scripts/check-docs-manifests.mjs`; stage new files before tree-walking guards.
- [x] Browser acceptance: expense save/documents/retry, six-person allocations,
  repayments, group FX, phone tables/filters/currency controls and refused new
  private integration; assert persisted results after reload.
- [x] Grep E2E selectors for renamed labels; update the driven controls' tests.
- [x] Develop English-first, regenerate pseudo-locale, then finish every supported
  locale after functional copy stabilizes, as the final implementation commit.
- [x] Capture the running implementation with synthetic data; label images/video
  by the actual tested revision and distinguish older evidence.
- [ ] Normal push to the existing feature branch; read back the PR head.
- [ ] Add a NEW PR progress comment following Ken's requested review location;
  keep issue evidence current with a new comment and do not rewrite old replies.

## Resource budget

Use the existing native verification mirror. One heavy command or database-backed
suite at a time, one worker, a process-group memory limit of 3500 MiB, limited CPU,
and at least 1536 MiB available host memory. If that reserve is crossed, stop the
owned workload and report it. Do not launch Docker or unrelated services.

The ordinary build may exceed that limit during combined phases. Use the supported
sequential compile/type-check/generate phases if needed and report their evidence
accurately. Do not call the combined build passed when it was stopped.

Run the assembled gate once; follow failures with focused checks. Repeat a broad
run only if later material changes invalidate its evidence. Coverage is CI's gate
unless the user separately requests a local coverage run. Stop task-owned services
after browser/database checks.

## Verification record: 28 October 2026

The current iteration was checked in a native source mirror, with one heavy
command at a time and the limits above. No Docker stack was started.

| Check | Observed result |
|---|---|
| Backend lint, source/test typechecks and build | Passed. |
| Backend changed tests | 658 of 659 files passed on the first run. The verification mirror retained upstream-deleted PDF helpers; after archiving those obsolete mirror files, the unchanged duplicate-function guard passed all 13 cases. The real branch and the guard were not changed to clear this failure. |
| Frontend lint and locale checks | Passed, including 1,826 locale-parity cases. |
| Frontend changed tests | 1,212 files, 23,508 cases; six failures on the assembled run. Fixed the code behind five contract/convention failures and updated the ordinary Transactions test for the approved removed handoff. All 348 cases in the seven affected suites passed afterward. No guard, baseline or allowlist was weakened. |
| Additional regressions | The HTTP boundary failed against the original routes and passed after the refusal guard. A foreign-currency payer test failed with the original precision condition, then all nine editor cases passed with the fix. Notification service: four cases passed. |
| Frontend production output | Compilation, typecheck and generation passed sequentially. Compilation peaked at 3,499 MiB with at least 3,049 MiB available host memory. The first typecheck found two invalid test-selector options; both were corrected, the two focused files passed all 11 cases, and the final typecheck passed. This is the supported phased build, not a claim that the combined build command passed. |
| PostgreSQL integration | All 43 cases in the three shared-expense suites passed with enforced RLS, one worker and at least 5,547 MiB available host memory. |
| E2E collection | Playwright discovered all nine scenarios in four files. This package has no standalone TypeScript command/config; an attempted `npx tsc` check was invalid and is not claimed as evidence. No dependency was added. |
| Browser acceptance | Chromium, one worker, retries disabled: eight scenarios passed initially. The file-link scenario raced the modal's asynchronous history traversal against reload; it now waits for the modal history entry to close. A subsequent test selector was corrected to the existing read dialog rather than an edit form. The focused scenario then passed, including persisted file count, entry link and related-entry opening. All nine scenarios have passing evidence; no all-project E2E pass is claimed. |
| Root checks | Environment documentation, documentation manifests and whitespace checks passed. |

Six unedited captures from the running build are in
`docs/future-plans/shared-expenses-core-screenshots/`: the expense form, overview
table, expense table, 320 px phone table, partial repayments and linked group
documents. They use synthetic data. The published issue comment pins their
commit; older screenshots/video depict earlier drafts with private booking.

The database suites use enforced RLS; the isolated
synthetic-data browser application uses RLS off, so its UI evidence must not be
presented as an RLS enforcement test. Owned application and database services were
stopped after each browser run. Publication follows these checks. The broad
changed-test suites are not repeatedly rerun after focused corrections; CI and
maintainer review remain separate from this local evidence.
