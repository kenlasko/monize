# Backend: database access, identity and tenancy

Rejection before the write, predicates written once, the role-safety classifier, whose identity a read runs under, and joint-account scope. The door itself (`withScopedDb`, the RLS contexts, the lint bans) is in `AGENTS.md`; this document holds the backend rules built on it. Read this before writing a query that decides ownership, authorization or which row counts.

Paths beginning with `src/`, `test/` or `scripts/`, and layer configuration filenames, are relative to `backend/`; other source paths are relative to `backend/src/`. Explicit repository prefixes are preserved. `backend/CLAUDE.md` is the short index; this document is where the reasoning lives.

## Rejection happens before the write

A check capable of refusing a command belongs inside the transaction that performs it, and under the same lock where concurrency is in play. A service that mutates, commits, and returns a success-shaped value for a caller to reject afterwards has already done the thing the `409` says it did not do.

Give the operation the caller's precondition as a parameter -- the expected owner, scenario or revision -- and let it refuse before writing. Return the refusal distinguishably: "no such row", "not yours" and "done" are three answers, and folding two into `null` makes the caller guess. Tests assert the rejected response **and** the stored state; see `docs/financial-calculation-contract.md` section 7.

## A predicate that decides which row counts is written once

When "is this row the one we mean" takes more than one clause (current algorithm version *and* matching configuration fingerprint), name it and call it. Spelled out per site it drifts invisibly: the GEM signal service wrote it four times and the fourth checked only the date, so a superseded row could be stored as the next period's predecessor. Same for the `where` that reads such a row back: a unique key that grew a column selects more than one row under the old `where` -- grep for reads of a unique key in the migration that widens it.

## One classifier decides whether a database role is safe

`common/db/runtime-role-check.ts` owns "may this role serve enforced traffic": one facts query template, one violation list, one verdict. Every surface asks through its exports -- `main.ts` about its own connection (`assertRuntimeRoleSafe`), `db-init` about the configured role by name (`assertRuntimeRoleSafeByName`). Do not write a second role-safety query (a hand-written copy in `app-role.ts` once blessed a role the runtime check then rejected, PR #1076). `runtime-role-check.spec.ts` pins the two exported queries to one template and the two asserts to one verdict per input.

## A read about somebody else needs somebody else's identity

`users_self` exposes exactly two rows to a session: `app_current_user_id()` and `app_real_user_id()`. **Any query keyed on another person -- by id, or worse, by email -- returns zero rows from the caller's own scope** under `RLS_MODE=enforce`, without raising or logging, and "no rows" looks like "no such user". (`AuthService` finds a login by email only because it runs pre-identity, under a bypass; `DelegationService.delegateEmailExists` ran the identical `where` under `scoped()` and told owners an account that demonstrably logs in did not exist.)

Before writing a query, ask whose row it is. There are three answers, not two:

| Whose row | Use | Why |
|---|---|---|
| The caller's | `scoped()` / `withScopedDb` | The policy is the point. |
| An owner's, read by their delegate | `withDelegateContext(owner, delegate)` | `current = owner, real = delegate` is the identity the policies were written for. **No bypass** -- `app.real_user_id` stays true about who is authenticated. |
| A delegate's, read by their owner (or any genuine cross-user sweep) | `withSystemContext` | There is no policy arm for it. Decide authorization *first*, under `scoped()`, and let only the minimum out. |

Reaching for `withSystemContext` when the middle row applies is the easy wrong answer: it works, so nothing complains, and the bypass fence widens by one.

`src/delegation/rls-context-smoke.spec.ts` is the guard, and its shape is worth copying: per-service specs mock `withScopedDb` away and are structurally incapable of seeing this class of bug, so that suite runs the **real** `withScopedDb` at `RLS_MODE=enforce`, records the ambient context at each repository call, and asserts the ordered sequence of identities plus the emitted `set_config` statements. Asserting the order is what proves the fence: the authorization read must appear under the caller's own identity *before* any bypass opens.

## A joint account is only shared where somebody remembered to share it

`transaction.userId = :userId` is the wrong ownership predicate for any own-context read a delegate can reach: a jointly shared account's rows belong to the **owner**, so the grantee matches none of them and the endpoint returns a confident empty answer (the register had joint scope on day one; the summary, grouped totals and monthly totals beside it did not).

Own-context reads resolve their scope through `TransactionsController.resolveOwnContextJointScope` (the accounts controller's equivalents are `jointAccountIdSetFor` for list reads and a `NotFoundException` fallback through `jointAccessFor` for `:id` reads, as on `getBalance` and `getBalanceForecast`). Filtered to exactly one joint account, the query runs as the owner so every derived value is byte-identical to the owner's own view; anything else keeps the caller's scope and widens it by the already-authorized joint ids, never by raw request input. The widened predicate is written once per service (`registerScope`, `analyticsScope`). An endpoint that deliberately stays owner-only says so where it is skipped (`tag-key-breakdown` does: tags are personal).

## An acting delegate's limits live only in application code

While a delegate acts, `req.user.id` is the owner and every query runs with the owner's identity (under `RLS_MODE=enforce` too), so nothing in the database knows which accounts or sections the delegation granted. `AccountDelegateGuard` and the controllers are the whole of it.

- **A write needs the grant on every account its body names**, not only on the row it edits. The route declares each extra body path with `@DelegatedBodyAccounts(...)` (a `[]` suffix walks an array, as in `splits[].transferAccountId`), and a transfer pair with `@DelegatedTransferBody(...)`, which carries the cross-owner relaxation; the guard refuses with 403 before the handler runs. A new DTO field that names an account on a delegate-reachable route is added to that route's decorator in the same commit; `account-delegate.guard.body-accounts.spec.ts` reads the real route metadata for every such field.
- **A read narrows to the delegate's READ-granted accounts**, never "all of the owner's". A controller resolves the scope with `delegateReadableAccountScope` (`backend/src/delegation/delegate-account-scope.util.ts`), which is `undefined` for an owner and possibly empty for a delegate, and the service applies it to every transaction query with `restrictToAccountScope`; an empty scope matches nothing. The category and payee detail pages do this, beside the register, analytics, portfolio and balance endpoints that intersect with `readableAccountIds` inline.
- **A scheduled read that answers another account's own figures needs READ on that account.** `@DelegatedScheduledParam` gates a read on the schedule's paying account alone, because the interceptor masks a transfer counterpart's name; a read whose answer is the counterpart's balance or rate (the loan occurrence projection, `GET /scheduled-transactions/:id/loan-occurrences`) adds `@DelegateReadsEveryScheduledAccount()`, which gates every account the schedule touches, strictly.
- **A route whose answer cannot be narrowed is refused unless nothing needs narrowing.** The AI assistant (`/ai/query`, `/ai/query/stream`) and `/ai/insights` read every account and section through tools that know nothing of a delegation, so they carry `@DelegateRequiresFullScope()`: a delegate reaches them only while `DelegationService.grantsWholeLedger` holds (every section, and a READ grant on every account the owner owns, closed ones included). Making each tool scope-aware would lift that restriction; until then a partial grant is told why and what to ask the owner for.

## `withScopedDb` in detail

The `AGENTS.md` states the door and the four identity contexts in a few lines. These are the details behind them.

// ...mutate + repo.save(row); all queries share the transaction + tenant GUC.
});
```

- Inject `DataSource`, not a repository. Get repositories from the transaction's `EntityManager` (`m.getRepository(X)`); helpers take the `EntityManager`, never a `QueryRunner`.
- `withScopedDb` **throws** without an ambient identity context. Authenticated cookie/JWT routes have it (`RequestContextInterceptor` seeds `{ userId }`). **Everything else must seed its own** (`backend/src/common/db/with-context.ts`):
  - `withUserContext(userId, fn)` -- cron per-user bodies, background writes, and any surface the interceptor cannot see. **Bearer-only routes count**: `/mcp` has no `AuthGuard('jwt')`, so the MCP transport seeds the bearer's user itself, per request (protocol revision 2026-07-28 has no session at all).
  - `withSystemContext(fn)` -- genuinely cross-user work: cron fan-outs, seeders, bootstrap hooks (`onModuleInit` / `onApplicationBootstrap` have no request), admin, and anything that sweeps every user.
  - `withDelegateContext(ownerUserId, delegateUserId, fn)` -- a delegate acting on an owner's data, where the two GUCs must **differ**. `withUserContext` collapses them onto one id, which silently returns zero rows for whichever half it is not. Used by `jwt.strategy`'s acting-context re-validation and `AccountDelegateGuard`.
  - `withPreserveTimestamps(fn)` -- extends the ambient context (identity inherited, never granted) so the GUC-aware `updated_at` trigger keeps supplied values. Backup restore is the only caller; it replaced the restore's old `DISABLE TRIGGER` DDL, and trigger DDL must never come back (a source-scan guard in `backup.service.spec.ts` enforces this).
- Nested `withScopedDb` calls join the ambient transaction (same connection/atomicity), so a service method calling another is safe. The exceptions are deliberate: `runOutsideActiveScopedManager` for a background timer or a progress write a concurrent reader must see.
- **Queries inside a transaction are awaited one at a time.** A transaction is one `pg` client, and a nested `withScopedDb` joins it, so `Promise.all`, `Promise.allSettled` or `mapWithConcurrency` over its manager runs nothing in parallel: the server executes one statement per session regardless. What it does do is hand `pg` a statement while the client is still busy, which `pg` queues client-side; that queue is deprecated and goes in pg@9, and from the third statement in flight every process logged "Calling client.query() when the client is already executing a query is deprecated". A fan-out whose branches each open their own `withScopedDb` gets a pooled connection per branch only while no transaction is open: reached from inside one, every branch joins it and they share its connection again, so a method that fans out that way must not be reachable from a transaction (`NetWorthService.loadValuationSeries` was, through `recalculateAccount`). `backend/src/common/db/transaction-fan-out.guard.spec.ts` fails a fan-out inside a `withScopedDb` callback, a callback handed to a local wrapper of it, or a function taking an `EntityManager` or `Repository<...>`; it does not follow calls, so the reachability half is the reviewer's. The same rule holds for the one connection outside the pool: `PgListener` chains the statements on its `LISTEN`/`NOTIFY` session, because every replica-wide wake-up (one per price written, during a refresh) is sent on it without waiting for the last.
- A callback that returns early (before writing) commits an empty transaction -- the correct replacement for an explicit rollback, not a bug.
- Pass an isolation level as the optional third argument only when the logic depends on it (registration uses `"SERIALIZABLE"` for the first-user-admin race). Requesting one while joining an ambient transaction throws rather than silently downgrading.
- At `RLS_MODE=off` (the default) `withScopedDb` still wraps the transaction but skips the identity GUCs. See `docs/future-plans/row-level-security.md`.
- **`docs/row-level-security-contract.md` is canonical** for which tables are exempt from RLS and why. There is exactly one sanctioned direct-`DataSource` exception -- `oauth_payloads`, reached by the `oidc-provider` adapter with no ambient context because the provider is mounted as raw Express middleware outside Nest's pipeline. It is not precedent for a user-owned table; `eslint.config.mjs`'s `OAUTH_PAYLOAD_ALLOWLIST` plus `backend/src/oauth/oauth-payload-access.spec.ts` fail when a second production reader appears. The exempt-table list lives once, as `RLS_EXEMPT_TABLES`.
