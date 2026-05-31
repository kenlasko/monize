# Monize Code Audit — Efficiency, Speed & Consistency

Audit performed 2026-05-30 via parallel domain agents (backend data-access, backend
duplication, frontend rendering, frontend duplication, cross-cutting infrastructure).
Read-only review of `backend/src`, `frontend/src`, and repo-level config.

Status legend: `[ ]` open, `[x]` done, `[~]` in progress.

The codebase is fundamentally healthy. Shared-foundation rules are largely honored
(`console.*` clean, `userId` always from JWT, every heavy service has a spec, AI/MCP
tool-sharing mostly correct, real shared API/format/types layer on the frontend). The
real wins cluster in a few hot paths plus "a helper exists but people reinvent it" drift.

---

## P0 — Correctness-adjacent (fix first)

- [x] **1. `updateStatus` mutates account balance + transactions across 4 writes with no
  QueryRunner.** A mid-operation failure desyncs balance vs status. `updateBalance` already
  accepts an optional `queryRunner`. `markCleared`/`reconcile`/`unreconcile` route through it.
  `transactions/transaction-reconciliation.service.ts:22-73`
  DONE: the status change + balance adjustment are wrapped in a single QueryRunner that
  commits atomically (rolls back on failure); added rollback-contract tests.
- [x] **2. Two divergent net-worth computations.** MCP `get_net_worth` -> `getSummary` sums
  raw `currentBalance` with a hardcoded asset/liability list, ignoring market value + future
  sums; `get_account_balances` -> `getLlmBalances` uses market value. Same user, two different
  net-worth numbers from the AI. Consolidate valuation + asset/liability classification.
  `accounts.service.ts:866-908` vs `:921+`, `net-worth.service.ts:80-170`
  DONE: `getSummary` now derives assets/liabilities/netWorth from the canonical
  `getMonthlyNetWorth` (same source as the dashboard widget and `get_account_balances`);
  `totalBalance` stays the raw book-balance sum. The frontend does not consume this endpoint,
  so no UI impact.

---

## P1 — High-impact performance (hot paths, largest table)

- [x] **3. Transaction register paginates in memory.** `findAll()` joins to-many relations
  (tags, splits, linkedSplits) then `.skip/.take` — TypeORM cannot push LIMIT to SQL with
  collection joins, so it fetches the whole row-explosion per user and paginates in JS. The
  hottest read path. Fix: two-phase (lean ID page, then `whereIn(ids)` hydrate) or
  `relationLoadStrategy:'query'`. `transactions.service.ts:297-420`
  INVESTIGATED - PREMISE CORRECTED, NO CODE CHANGE. The query uses `.skip()/.take()`, and
  TypeORM 0.3.28 (verified in node_modules SelectQueryBuilder.executeEntitiesAndRawResults,
  the `(skip||take) && joinAttributes.length>0` branch) paginates it via a distinct-primary-
  key subquery with LIMIT/OFFSET pushed to SQL, then hydrates only that page; count uses
  COUNT(DISTINCT pk). So it does NOT paginate the row-explosion in JS. `relationLoadStrategy`
  does not apply to explicit `leftJoinAndSelect`. Residual cost (join materialized before the
  distinct/count) is real but optimizing it reimplements TypeORM's pagination; deferred to a
  profiling-backed change with e2e coverage.
- [ ] **4. Custom reports load up to 50,000 transactions and group/sum in Node.** Push
  `GROUP BY`/`SUM` into Postgres. `reports.service.ts:421-424`, aggregation `602-867`
  DEFERRED (per audit decision): large, correctness-sensitive rewrite (splits, multi-dimension
  grouping, currency). Tackle with profiling against a real DB.
- [x] **5. Unbounded `Promise.all` over Yahoo on a live portfolio-chart request** — N holdings
  = N concurrent external calls in user latency. Bounded concurrency + 60s intraday cache.
  `portfolio.service.ts:924-941, 1066-1080`
  DONE: both intraday holding and intraday FX fan-outs now use `mapWithConcurrency` (limit 6).
  (Intraday response caching not yet added — see follow-up note under #7.)
- [x] **6. Unbounded `Promise.all` in `refreshAllPrices` across all users' securities** —
  hundreds of simultaneous Yahoo/MSN requests; the 429-retry only reacts after the burst.
  Shared concurrency cap. `security-price.service.ts:350-358, 474-481`
  DONE: both quote fan-outs use `mapWithConcurrency` (limit 6); the FX refresh cron burst in
  `exchange-rate.service.ts` was capped the same way.
- [ ] **7. No quote/price caching or in-flight dedup** for Yahoo/MSN/FX. Two users holding
  AAPL = two fetches; chart reloads refetch identical series. Short-TTL quote cache +
  in-flight promise map. `yahoo-finance.service.ts`, `currencies.service.ts:344,476`
  DEFERRED (not selected this pass): worthwhile but needs careful TTL/invalidation design and
  staleness testing. The fan-out is now at least concurrency-bounded (see #5/#6).
- [ ] **8. `AccountList` renders every account, no virtualization/pagination**, heavy per-row
  SVG rows re-render on any sort/filter/density change. Virtualize or paginate.
  `AccountList.tsx:678-752`
  DEFERRED (per audit decision): frontend react-window work needing visual verification;
  handle in a dedicated frontend pass.

**Recurring root cause for #5/#6:** no shared bounded-concurrency util in `common/` — every
fetch site reinvents naive `Promise.all` or a hand-rolled `setTimeout(500)` loop (duplicated
4+ times). One `mapWithConcurrency` util fixes #5, #6, the FX backfill, and the cron collision.
DONE: added `common/concurrency.util.ts` (`mapWithConcurrency`, order-preserving,
fail-fast, fully unit-tested). Applied to #5, #6, the FX refresh cron, and #17.

### N+1 / per-row write loops (collapse each to a single bulk statement)

- [x] **9. Net-worth charts:** per-selected-account linked-account resolution ->
  `WHERE id = ANY($1)`. `net-worth.service.ts:347-355, 607-615`
  DONE: both sites resolve all requested accounts plus their linked pairs in a single
  `id = ANY($1) OR linked_account_id = ANY($1) OR id IN (...)` query.
- [x] **10. Bulk tag update:** ~3N queries (validate+delete+insert per txn) -> validate once
  + one bulk delete + one multi-row insert. `transaction-bulk-update.service.ts:146-155` ->
  `tags.service.setTransactionTags`
  DONE: added `TagsService.setTransactionTagsBulk` (validate once, one
  `DELETE ... WHERE transaction_id IN (...)`, one multi-row insert of the txn x tag product);
  the bulk-update service now calls it once instead of looping `setTransactionTags`.
- [x] **11. Per-row balance UPDATEs** in deferred-balance cron / post-import /
  `reorderFavourites` / bulk payee save -> single `UPDATE ... FROM (VALUES ...)`.
  `accounts.service.ts:1293-1298, 1327-1338`, `import.service.ts:1654-1686`,
  `payees.service.ts:549-560`
  DONE: `reorderFavourites`, the deferred-balance cron, and the post-import recompute now
  each apply balances in a single bulk `UPDATE ... FROM (VALUES ...)` (post-import also
  collapsed 3-queries-per-account into one grouped balance query). Bulk payee deactivation
  was already a single `find` + single batched `save` (no per-row loop), so left as-is.
- [x] **12. Split-transfer cleanup** does `findOne` per split -> batch with `In(...)`.
  `transactions.service.ts:1558-1582`
  DONE: linked transfer transactions for a parent's splits are now fetched in one
  `In(linkedIds)` query; the per-transaction balance/remove logic is unchanged.

---

## P2 — Performance polish

- [ ] **13. Reports page rebuilds map+filter+sort (and SVG icon nodes) on every keystroke**,
  no `useMemo`, no search debounce. `app/reports/page.tsx:722-772`
- [ ] **14. DividendIncomeReport fetch waterfall:** accounts + capital-gains wait behind the
  sequential transaction-pagination loop; inline MultiSelect options rebuilt each render.
  `DividendIncomeReport.tsx:254-273, 989-995`
- [ ] **15. Whole-store Zustand subscriptions** (destructuring instead of slice selectors);
  widest-reach is `ProtectedRoute.tsx:18-19` (wraps every authed page); also `AppHeader`,
  `FavouriteAccounts`, dashboard.
- [x] **16. Anthropic provider has no prompt caching** (`cache_control` zero hits repo-wide)
  — resends large financial-context system prompts at full token cost every turn.
  `ai/providers/anthropic.provider.ts:98-107`
  DONE: wrap the system prompt in a single `cache_control: ephemeral` text block across all
  four call sites; since tools render before system, one breakpoint caches the tools+system
  prefix so repeated multi-turn tool-use turns hit the prompt cache.
- [x] **17. "Batched" AI-insights cron is actually fully sequential** (`for ... await` inside
  the batch) — batching is dead code. `ai-insights.service.ts:246-261`
  DONE: replaced the dead batch loop with `mapWithConcurrency` at a conservative limit of 5
  (LLM calls per user), preserving the per-user try/catch so one failure does not abort the run.
- [x] **18. `refreshAllPrices` re-scans everything** with no staleness filter.
  `security-price.service.ts:312-330`
  DONE: skip securities that already have a price row dated today before fanning out, and
  report the skipped count. Conservative: outside the post-close window nothing matches.
- [x] **19. Two Yahoo crons collide at 17:00 ET** (price + FX refresh) — stagger them.
  `security-price.service.ts:947`, `exchange-rate.service.ts:609`
  DONE: FX refresh moved to 17:05 ET (`5 17 * * 1-5`); `docs/cron-jobs.md` updated.
- [x] **20. Report search `LOWER(col) LIKE '%term%'`** on un-indexed `payee_name`/`description`
  -> seq scans. Add `pg_trgm` GIN indexes. `reports.service.ts:402, 545-549`
  DONE: migration 080 enables `pg_trgm` and adds GIN trigram indexes on
  transactions.payee_name/description and payees.name/categories.name (the search uses ILIKE,
  which gin_trgm_ops accelerates directly); schema.sql updated for fresh installs.

---

## P2 — Consistency / duplication (helpers exist, get reinvented)

### Frontend (presentation drift)

- [ ] **21. `LoadingSkeleton.tsx` is dead code** — 0 imports, yet 63 components hand-roll
  `animate-pulse` skeletons. Highest-leverage cleanup.
- [ ] **22. Signed-percent formatting reimplemented 40+ times** as
  `${v>=0?'+':''}${v.toFixed(1)}%`, bypassing `useNumberFormat`. Add `formatSignedPercent`.
- [ ] **23. Gain/loss green/red ternary inlined in 71 files** with no helper. Add
  `gainLossColor(value)` to `lib/format.ts`.
- [ ] **24. ~40 report components duplicate fetch/loading boilerplate** — and none track an
  error state (`setError` count = 0 across reports -> failed fetches silently show empty).
  Extract `useReportData(fetcher, deps)`.
- [ ] **25. `SummaryCard`/`SummaryIcons` exist but reports hand-roll** the card container
  string (appears in 42 files); 23 reports define their own inline Recharts tooltip.
- [ ] **26. 3 forms bypass mandated rhf+Zod** (`BulkUpdateModal`, `CreateUserModal`,
  `MonteCarloSaveAsDialog`); `formatQuantity` copied in 3 investment lists; email Zod schema
  duplicated in 3 auth pages.

### Backend (logic drift)

- [x] **27. `convertCurrency` reimplemented twice** with different fallback behavior — net-worth
  vs report-currency can convert the same amount differently.
  `net-worth.service.ts:1376-1398` vs `report-currency.service.ts:65+`
  DONE: extracted `common/currency-conversion.util.ts` (`convertWithRateLookup`) as the single
  direct/inverse decision; each service parameterizes it with its own rate source.
- [x] **28. YMD date formatting inlined ~12 times** despite `formatDateYMD` helper.
  DONE: added `formatDateYMDLocal` (local components, distinct from UTC `formatDateYMD` and
  TZ-aware `todayYMD`) for the 5 inline local-time "today" sites; budget month-end sites now
  use the existing `getMonthEndYMD`. Behavior preserved exactly.
- [x] **29. Inline `Math.round(x*10000)/10000`** alongside imported `roundMoney`.
  DONE: migrated the money-rounding sites (exchange-rate inverse rate, AI usage cost,
  post-import balance, OFX parser amount) to `roundMoney`. The documented per-share-price
  `round4` helper in investment-transactions is intentionally left (distinct semantics).
- [x] **30. MCP `search_transactions` re-implements split-expansion + amount-filter** in the
  tool layer (CLAUDE.md violation). `transactions.tool.ts:101-139`
  DONE: moved to `TransactionsService.getLlmTransactionRows`; the MCP tool is now a thin
  adapter. Behavioral tests live on the service spec.
- [x] **31. `parseFloat` vs `Number`** split for decimal parsing, concentrated in
  `built-in-reports/*`. Standardize on a `toMoneyNumber()` helper.
  DONE: added `common/round.util` `toMoneyNumber` (Number-based parse, NaN->0, 4dp round) and
  applied it across the comparison/income/spending/anomaly/tax/data-quality report services.
- [ ] **32. docker-compose backend `environment:` block copy-pasted across 4 files** (drift
  risk on new env vars). Extract a shared base via `extends`/`env_file`.
  SKIPPED (judgment call): the dev/prod/e2e files differ substantially and intentionally
  (network names, `build` vs `image`, and the `${VAR:-default}` vs `${VAR}` syntax IS the
  per-environment behavior). `env_file` cannot express the compose-default interpolation, and
  an `extends` base would still need per-file overrides for most vars while making any single
  environment harder to read. The dedup value did not justify restructuring deployment-critical
  files that can't be fully validated here. Left as-is.

---

## Verified clean (do not re-flag)

`console.*` discipline; `userId` from JWT (303/303); every heavy service has a spec; most
`getLlm*` tools correctly shared AI<->MCP with identical shapes; split/transfer/bulk-update
sub-services use QueryRunner; centralized axios client + CSRF/refresh interceptors;
`getErrorMessage` used 64x; money ledger paths use `sumMoney`/`roundMoney` correctly (no real
float-accumulation bugs); Yahoo `throttledFetch` backoff; apiCache dedupe/TTL + shared
`useExchangeRates`.
