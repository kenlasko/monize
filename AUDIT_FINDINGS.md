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

- [ ] **1. `updateStatus` mutates account balance + transactions across 4 writes with no
  QueryRunner.** A mid-operation failure desyncs balance vs status. `updateBalance` already
  accepts an optional `queryRunner`. `markCleared`/`reconcile`/`unreconcile` route through it.
  `transactions/transaction-reconciliation.service.ts:22-73`
- [ ] **2. Two divergent net-worth computations.** MCP `get_net_worth` -> `getSummary` sums
  raw `currentBalance` with a hardcoded asset/liability list, ignoring market value + future
  sums; `get_account_balances` -> `getLlmBalances` uses market value. Same user, two different
  net-worth numbers from the AI. Consolidate valuation + asset/liability classification.
  `accounts.service.ts:866-908` vs `:921+`, `net-worth.service.ts:80-170`

---

## P1 — High-impact performance (hot paths, largest table)

- [ ] **3. Transaction register paginates in memory.** `findAll()` joins to-many relations
  (tags, splits, linkedSplits) then `.skip/.take` — TypeORM cannot push LIMIT to SQL with
  collection joins, so it fetches the whole row-explosion per user and paginates in JS. The
  hottest read path. Fix: two-phase (lean ID page, then `whereIn(ids)` hydrate) or
  `relationLoadStrategy:'query'`. `transactions.service.ts:297-420`
- [ ] **4. Custom reports load up to 50,000 transactions and group/sum in Node.** Push
  `GROUP BY`/`SUM` into Postgres. `reports.service.ts:421-424`, aggregation `602-867`
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
- [ ] **8. `AccountList` renders every account, no virtualization/pagination**, heavy per-row
  SVG rows re-render on any sort/filter/density change. Virtualize or paginate.
  `AccountList.tsx:678-752`

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
- [~] **11. Per-row balance UPDATEs** in deferred-balance cron / post-import /
  `reorderFavourites` / bulk payee save -> single `UPDATE ... FROM (VALUES ...)`.
  `accounts.service.ts:1293-1298, 1327-1338`, `import.service.ts:1654-1686`,
  `payees.service.ts:549-560`
  PARTIAL: `reorderFavourites` now uses a single bulk `UPDATE ... FROM (VALUES ...)`.
  Deferred-balance cron, post-import recompute, and bulk payee save still pending.
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
- [ ] **16. Anthropic provider has no prompt caching** (`cache_control` zero hits repo-wide)
  — resends large financial-context system prompts at full token cost every turn.
  `ai/providers/anthropic.provider.ts:98-107`
- [x] **17. "Batched" AI-insights cron is actually fully sequential** (`for ... await` inside
  the batch) — batching is dead code. `ai-insights.service.ts:246-261`
  DONE: replaced the dead batch loop with `mapWithConcurrency` at a conservative limit of 5
  (LLM calls per user), preserving the per-user try/catch so one failure does not abort the run.
- [ ] **18. `refreshAllPrices` re-scans everything** with no staleness filter.
  `security-price.service.ts:312-330`
- [x] **19. Two Yahoo crons collide at 17:00 ET** (price + FX refresh) — stagger them.
  `security-price.service.ts:947`, `exchange-rate.service.ts:609`
  DONE: FX refresh moved to 17:05 ET (`5 17 * * 1-5`); `docs/cron-jobs.md` updated.
- [ ] **20. Report search `LOWER(col) LIKE '%term%'`** on un-indexed `payee_name`/`description`
  -> seq scans. Add `pg_trgm` GIN indexes. `reports.service.ts:402, 545-549`

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

- [ ] **27. `convertCurrency` reimplemented twice** with different fallback behavior — net-worth
  vs report-currency can convert the same amount differently.
  `net-worth.service.ts:1376-1398` vs `report-currency.service.ts:65+`
- [ ] **28. YMD date formatting inlined ~12 times** despite `formatDateYMD` helper (add a
  `formatDateYMDUtc` for the UTC variants).
- [ ] **29. Inline `Math.round(x*10000)/10000`** alongside imported `roundMoney`
  (investment-transactions has 13; exchange-rate doesn't import the util at all).
- [ ] **30. MCP `search_transactions` re-implements split-expansion + amount-filter** in the
  tool layer (CLAUDE.md violation) and has no AI-executor twin. `transactions.tool.ts:101-139`
- [ ] **31. `parseFloat` vs `Number`** split for decimal parsing (67 vs 519), concentrated in
  `built-in-reports/*`. Standardize on a `toMoneyNumber()` helper.
- [ ] **32. docker-compose backend `environment:` block copy-pasted across 4 files** (drift
  risk on new env vars). Extract a shared base via `extends`/`env_file`.

---

## Verified clean (do not re-flag)

`console.*` discipline; `userId` from JWT (303/303); every heavy service has a spec; most
`getLlm*` tools correctly shared AI<->MCP with identical shapes; split/transfer/bulk-update
sub-services use QueryRunner; centralized axios client + CSRF/refresh interceptors;
`getErrorMessage` used 64x; money ledger paths use `sumMoney`/`roundMoney` correctly (no real
float-accumulation bugs); Yahoo `throttledFetch` backoff; apiCache dedupe/TTL + shared
`useExchangeRates`.
