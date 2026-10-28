# Accrual read-model redesign contract

Approved direction: owner requested the first-principles redesign on 2026-10-27 after maintainer performance feedback on PR #1883. Preserve the existing schedule editor, equal allocations, source-edit validation and allocation persistence. Replace the ledger-wide table-shadowing read strategy.

## Invariants

1. Disabled accruals execute ordinary cash queries. New defaults are cash. Existing schedules and saved choices are retained when disabled; source writes continue maintaining their existing schedules through scoped transactions so re-enabling cannot expose stale allocations.
2. A selected accrual view with no relevant schedules may execute native queries, but selection, response identity, pagination and cache semantics remain consistent. Resolve eligibility across the authorized owner/joint-account scope once per read; do not cache schedule existence across requests.
3. Recognition rows are a read model, not bank transactions. Existing stored allocations are the recognition facts. Unscheduled components retain their cash date. A scheduled component contributes only its allocation on its effective date.
4. Explicit reporting relations use distinct names. They do not shadow transactions, splits, tags or investments through same-name CTEs. Cash readers and unrelated entities never consult them. Query factories select the appropriate read-only entity/relation explicitly.
5. Ordinary SQL views are a candidate implementation: SECURITY INVOKER preserves caller RLS, explicit typed columns avoid JSON record reconstruction, UNION ALL keeps unaffected rows on indexed base-table branches, and aggregation is limited to affected sources. Actual query plans and performance tests decide whether this is sufficient.
6. Account, owner, date and identity restrictions must reach the appropriate base/recognition branches before expensive work. Recognition dates, not payment dates, decide which allocation is in a reporting window. A payment outside the window with allocations inside must remain visible.
7. Register count, ordering and page selection share the same effective rows. Visible rows retain stable report/source identities and parent navigation; bank balances and reconciliation retain cash semantics.
8. Prepaid/unearned balances continue to derive from settlement versus recognition through the selected date. No second complete journal or duplicate bank transactions.

## Numerical and edge examples

A USD -1200 payment on 2026-10-15, spread October through September, remains one -1200 cash payment. Accrual reporting recognizes -100 per month. Filtering November includes its allocation even though the cash date is October. A split with an unscheduled -20 and scheduled -120 contributes -20 at payment and the scheduled monthly components at their effective dates. Rounding remainder stays in the final allocation. Disabling restores cash presentation without deleting either schedule.

Missing FX keeps existing refusal/nullable-total contracts appropriate to each reader; source-entered rates, native precision and tenant/delegate masking must not change.

## Acceptance matrix

- Feature disabled; enabled with zero, one and many schedules.
- First/last schedule creation/deletion changes execution strategy on the next read.
- Source edit while disabled, then re-enable: allocations match the edited source.
- Whole transaction and partial split schedules; past/future dates; category/payee/tag filtering; transfers and investments; stable pagination/count; FX completeness; RLS and joint/delegate scope.
- Real PostgreSQL ledger: 35,738 transactions, 10,281 splits, one 641-row account and predominantly absent link/parent relationships. Record count/page latency, EXPLAIN (ANALYZE, BUFFERS), and query work for zero/one/many schedules. Initial generous 5-second local/CI ceiling catches the 48-second failure; compare to native cash and tighten only with measured evidence. A no-schedule optimization alone does not satisfy acceptance.

No production deployment is part of this task. Additive migrations and schema remain paired; preserve applied migrations and do not reset explicit preferences blindly.

## Interactive query execution

Recognition SQL executes in the caller's existing scoped transaction with a temporary JIT opt-out. PostgreSQL's cost estimates for nested invoker/RLS relations can trigger seconds of compilation for a query that executes in tens of milliseconds. The reader saves the current setting, disables JIT with transaction-local `set_config`, and restores it after success. SQL failures propagate unchanged; the caller's rollback restores local settings. Cash execution never reads or changes JIT configuration. No server or pool default changes.

This supplements explicit relations, native cash fast paths and page-bounded hydration; it does not replace those optimizations. The regression ledger covers 35,738 initial transactions, 10,281 splits, zero/one/many schedules, category reporting and exports. The benchmark asserts that successful calls preserve the caller's JIT setting.

PostgreSQL documents the compilation tradeoff in [When to JIT?](https://www.postgresql.org/docs/16/jit-decision.html).

## Validation checkpoint

The regression fixture covers disabled, zero/one/many schedules, accrued splits, explicit Cash, real category reporting and source-linked exports under enforced PostgreSQL RLS. In the merged-source full integration run, whole-case timings were 108 ms disabled, 83 ms enabled with no schedules, 1,034 ms for the first schedule (including its setup), 414 ms for accrued splits, 342 ms with 102 schedules, and 367 ms for category reporting plus export. These are synthetic-ledger timings on the validation host, not a promise for every deployment. Successful reads also assert that the caller’s JIT setting is preserved.
