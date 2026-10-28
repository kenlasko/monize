# Accrual read-model redesign tasks

- [x] Record the owner-approved redesign contract and implementation sequence.
- [x] Reproduce the large-ledger slowdown and save baseline evidence.
- [x] Implement feature-off cash execution and consistent defaults/selection.
- [x] Move accrual settings into Transactions above quick-fill.
- [x] Implement explicit scoped recognition relations/readers without ledger table shadowing.
- [x] Migrate register, report, budget and export readers.
- [x] Validate retained schedule edits while disabled and re-enable behavior.
- [x] Pass zero/one/many-schedule large-ledger regression tests and capture plans/timings.
- [x] Pass correctness, RLS, static, migration and automated frontend checks.
- [x] Refresh the changed-file inventory and prepare validated commits and the PR refactor summary.

Validation against upstream `57f36e2fc`: 740 changed backend spec files, 190 PostgreSQL integration suites (2,070 passing tests; 8 skipped), and 1,204 clean-source frontend test files (23,440 tests) pass. Lint, source/test types, builds, translation checks and two-pass schema replay pass. Frontend tests run before vendor/build artifact generation, matching CI. Manual browser release acceptance and deployment remain separate release steps.
