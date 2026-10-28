# Accrual accounting integration tasks

- [x] Capture the pre-accrual baseline and isolate the accrual delta by file hashes.
- [x] Fetch upstream and fork refs; fast-forward local main and branch from latest upstream.
- [x] Transfer persistence, backend, frontend, reporting and test changes.
- [x] Resolve upstream overlaps while retaining warranty and reporting changes.
- [x] Record the feature contract and integration plan before the implementation commit.
- [x] Finish current-upstream compatibility checks and regression validation.
- [x] Record the final changed-file inventory and validation evidence.
- [x] Commit the implementation with Conventional Commits and AI co-author trailer.
- [ ] Obtain/link upstream scope approval, ownership and approved-to-build designation.
- [ ] Agree on upstream default and review-series size with the maintainer.
- [x] Publish the requested feature branch and PR (upstream PR #1883).

## Resumed validation, October 26, 2026

The published branch includes the specification, implementation, translations and CI guard fixes. PR #1883 is open. The prior uncommitted handoff is historical.

An additional rule/accrual regression suite covers reviewed manual edits, automatic-write refusal, deleted references, stale source hashes, history restoration and source locking. Its focused run passes 24 tests; strict lint and backend test-inclusive types pass. The full backend coverage gate passes without changing thresholds: 1,111 suites, 28,934 passing tests and four existing skips; statements 95.01%, branches 85.95%, functions 95.04%, lines 95.87%. Import protections and reporting provenance mapping have 17 additional passing cases.

The published frontend CI run has one failure in the unchanged investment transaction form's dated-FX rejection test. Its complete 100-test file passes locally; this remains a reported CI failure, not a verified fix. No investment code or assertion was changed.

## CI compatibility repair

Corrected dated-rate test fixtures, FK comparison by reference target, budget basis query validation, and the nullable account-summary / LLM native-bucket adapters. Cash-specific browser scenarios request cash mode explicitly. Final changed backend batch passes 714 files, including guards; targeted browser scenarios pass eight cases each in Chromium and Firefox with no retries. Full GitHub CI must be rechecked on the repair commit.

## Bill reminder projection regression

- [x] Reproduce the maintainer's notification-column error against PostgreSQL with enforced RLS.
- [x] Restore ordinary scoped notification reads and restrict recognition projection to transaction roots.
- [x] Verify due reminders and repeated-read deduplication in cash/accrual mode, plus adjacent reporting coverage: 28 integration tests and 774 changed backend test files/guards pass.
