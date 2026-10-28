# Accrual read-model redesign

Contract: `docs/specs/accrual-read-model.md`. Task list: `docs/future-plans/accrual-read-model-tasks.md`.

1. Capture a synthetic large-ledger baseline and demonstrate the current query failure.
2. Implement real feature-off behavior, cash defaults, centralized selection/execution semantics and the settings move. Preserve lifecycle consistency for retained schedules.
3. Prototype explicit invoker reporting views/read entities and scoped query factories using existing allocations. Measure before adopting; use no table-shadowing CTEs or JSON record conversion. Keep cash repositories untouched.
4. Migrate register, analytics, built-in/custom reports, budget actuals and exports to explicit readers. Use query restrictions and normal ORM pagination/count against the read model; optimize identity-first hydration where plans show a need.
5. Validate correctness, RLS and realistic performance together. Preserve bank/source writes and source-linked editor behavior.
6. Update server tasks, changed-file inventory and benchmark evidence throughout. Push reviewable commits to the existing PR after local checks; no production deployment or unsolicited PR comments.
