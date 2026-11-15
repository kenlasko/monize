# Row-Level Security contract

What row-level security guarantees in Monize, which tables are exempt from it and
why, and which direct-`DataSource` access paths are sanctioned. This is the
canonical document: migration comments, the schema, the runbook and the source
point here rather than restating a rationale of their own.

Read this before adding a table, exempting one, or reaching the database by any
route other than `withScopedDb`.

Operational material -- rollout stages, mode flips, monitoring, emergency
rollback -- stays in `docs/rls-runbook.md`. The original design is
`docs/specs/row-level-security.md`; it describes work that has since shipped,
and where it disagrees with this document, this document wins.

## 1. What RLS is here

Defence in depth, behind application-level ownership predicates -- not a
replacement for them. Every user-owned table carries a policy comparing the
row's owner against transaction-local identity GUCs that `withScopedDb`
(`backend/src/common/db/scoped-db.ts`) emits. Application code still filters by
`userId`; RLS is what contains the query that forgets to.

`RLS_MODE` selects how much of that is live:

| Mode | Identity GUCs | Runtime role | Effective RLS |
|---|---|---|---|
| `off` (default) | no | owner | disabled |
| `shadow` | yes | owner | policies bypassed |
| `enforce` | yes | unprivileged app role | enabled where policies exist |

Whether `enforce` should become the default is a separate, open decision
(issue #1065); it is deliberately not settled here.

Every table must land in exactly one of four buckets, and
`backend/test/integration/rls-enforcement.integration.spec.ts` fails when one
lands in none or several: **direct** (`user_id` column), **owner-column**,
**indirect** (`EXISTS` back to the owning parent), or **exempt**. The first
three are described in `database/CLAUDE.md`. This document owns the fourth.

`scheduled_transaction_postings` gained the settlement claim columns
(`transaction_id`, `source`, `rule_id`, `pricing`;
`docs/specs/loan-installment-settlement.md` section 5.2) and stays **indirect**:
its policy, an `EXISTS` back to `scheduled_transactions.user_id`, is unchanged.

## 2. The exempt tables

The set is `RLS_EXEMPT_TABLES` in
`backend/src/common/db/rls-exempt-tables.ts`, mirrored as `rls-exempt:` marker
lines in the block at the foot of `database/schema.sql`.
`backend/src/common/db/rls-exempt-tables.spec.ts` checks the two against each
other in both directions, with no database, and throws if the marker block goes
missing.

That checking exists because the list was previously written out in four places
-- migration 114, the schema block, and one array in each of the two RLS
integration specs -- plus a fifth summary in `database/CLAUDE.md`, and had
already drifted. The migration documented four tables while the schema and the
specs carried six; one spec asserted the count in its own name ("leaves the four
exempt tables untouched") for a list of six; and the migration asserted that
"the catalog-driven test in T2 asserts this exact list" when by then it asserted
a different one. Both integration specs need a live PostgreSQL, so none of it
ran in `npm run test:unit` and nothing failed.

| Table | Why exempt |
|---|---|
| `auth_attempt_counters` | Rate-limit and lockout counters: how many times a wrong 2FA code, a forgot-password request or a step-up challenge has been seen inside a window. There is no owner column because the row is written on the *failure* path, before any identity is established -- a wrong code on a temp token, a reset request for an address that may not exist -- and because a per-user copy would not be the limit that matters when several replicas serve one account. `key` is a hash (`sha256(email)`, `sha256(tempToken)`, or a user id the caller already holds), which is what keeps a table every session can read from being a directory of who tried to log in. Written under whatever ambient context the unauthenticated route has; read only by the limiter that wrote it, and swept daily. |
| `auto_backup_policy` | The deployment's automatic-backup policy: one schedule, folder and retention for the whole instance. There is no owner column because there is no owner -- every account is reconciled onto this one row, and the operator who edits it is configuring the deployment rather than their own account. It is exempt for the reason it exists: the policy previously lived on the earliest active administrator's `auto_backup_settings` row, where deactivating, demoting or deleting that account handed a deployment-wide setting to whoever came next -- usually to nobody, so every account reverted to the built-in defaults -- and restoring that account's own backup replayed a months-old policy over the instance. Written under system context by the admin surface and by the hourly reconcile; also carries `manual_run_claimed_at`, the conditional-UPDATE claim that keeps two "back up every account" fan-outs from interleaving. Excluded from every per-user archive (`INTENTIONALLY_EXCLUDED_TABLES`), which is what closes the restore path. |
| `benchmark_series` | The registry of benchmark series a bond can read -- a central-bank reference rate, a CPI index -- with its kind (`STEP` or `MONTHLY`), publisher, source and `covered_through`, how far it has been fetched. There is no owner column because there is no owner: one series serves every account and every country's instruments, and a per-user copy would multiply provider traffic and let two users see different values for one series. Written by the reference refresh (system context) and, when a series that reads the benchmark is stored, by that store, which seeds the row in its own transaction; `covered_through` only moves forward. Excluded from every per-user archive (`INTENTIONALLY_EXCLUDED_TABLES`) because the deployment refetches it. |
| `benchmark_values` | The observations of a benchmark series: a rate effective from a date, or a CPI print for a reference month. No owner column -- one published value serves every account, exactly as an exchange rate does -- and a per-user copy would let two users see different values for one series and date. A correction is an update, not a new row. Excluded from every per-user archive. |
| `bond_programs` | One row per sovereign bond program (the product a person holds, e.g. EDO), keyed by issuer country, issuer and program code, so another country's products need no schema change; a security links to one (`securities.bond_program_id`) and each series (`bond_instruments`) belongs to one. There is no owner column because there is no owner: a program is the same for every account on the deployment, and a per-user copy would let two users hold different definitions of one product. Insert only, held by the same trigger as the series (`bond_reject_mutation`, INV-BOND-001); written under system context by the catalog seed (the adapters' programs, no series) and a series store, in the transaction of the first series of the program. Excluded from every per-user archive because the deployment reseeds it. |
| `bond_instruments` | One row per sovereign bond series, keyed by issuer country, issuer and series code, so another country's bonds need no schema change. There is no owner column because there is no owner: the terms of a series are published once and are the same for every account on the deployment. A per-user copy would multiply provider traffic by the number of accounts and let two users see different terms for one series. Insert only, held by a trigger (`bond_reject_mutation`, INV-BOND-001) that refuses `UPDATE` and `DELETE`; written by the series store (`BondCatalogService.storeEntry`), under the identity of the person whose fetch or entry stored it or the system context of the series cron. Excluded from every per-user archive because the deployment refetches it. |
| `bond_period_rates` | The published rate of each interest period of an instrument. No owner column, for the reason `bond_instruments` has none; a per-user copy would let two users value one series at different rates. Immutable once written (INV-BOND-001), held by a trigger rather than by the writer. Excluded from every per-user archive. |
| `bond_terms_versions` | The terms of an instrument as published, versioned per instrument and carrying a content hash, their source URL and retrieval time. No owner column, for the reason `bond_instruments` has none. Immutable once written (INV-BOND-001): a trigger refuses `UPDATE` and `DELETE`, so changed terms are a new version and a holding valued last year stays reproducible. Excluded from every per-user archive. |
| `currencies` | Global reference data keyed by ISO 4217 code. It carries `created_by_user_id`, but that is attribution (`NULL` = system currency), not ownership: any user may reference a custom code via `accounts.currency_code`, and a `created_by_user_id` policy would hide every system currency and break those foreign keys. Per-user visibility is already expressed by `user_currency_preferences`, which **is** policied. |
| `exchange_rate_coverage` | What a rate provider is known to hold for one currency pair, and where the next history fill resumes. There is no owner column because there is nothing to own: Yahoo's history for `USDCAD=X` starts in December 2003 for every account on the deployment, and a per-user copy would have each reader pay their own provider calls to learn the same date. One row per pair in the canonical orientation only (`from_currency < to_currency`, INV-FX-003), held by a CHECK constraint rather than by a convention in the writer -- a rate window answers a pair, not a direction. Scoped to a provider set as well: `providers` names the ordered chain that wrote the row, and a row written under any other `FX_PROVIDERS` configuration reads as never probed and has its dates replaced, not merged, by the next fill, because what Yahoo carries says nothing about what Frankfurter does. Written under whatever context the reader's own fill runs in, which is an authenticated request; read only by that fill. Excluded from every per-user archive (`INTENTIONALLY_EXCLUDED_TABLES`) alongside `exchange_rates` itself, because a restore that replayed one deployment's provider bookkeeping onto another would suppress history the second provider does carry. |
| `exchange_rates` | Global reference data with no owner column; written by the scheduled refresh under system context. A Microsoft Money import also inserts its file's rates, under the importing user's context, but only for dates the table holds nothing for (`ON CONFLICT ... DO NOTHING`, INV-FX-004), so one user's file cannot rewrite the rate another user converts at. |
| `fetch_sync` | Deployment-wide leases for the jobs one replica should run per tick: the three outbound market-data fetches (exchange rates, security prices, market indexes) and the attachment relocation pass that follows a storage-provider switch. There is no owner column because there is no owner -- one USD/EUR rate and one index close serve every account -- and `job_claims`, the per-user claim table, cannot express it: its `user_id` is a `NOT NULL` foreign key to `users`. The lease is a **cost control, not a correctness mechanism**: the fetches it guards write idempotent upserts, so N replicas running produce the same rows and N times the provider bill. Written under system context by those jobs; `lease_token` identifies the holder so a worker delayed past its own expiry cannot release a lease another replica retook. Distinct from `market_index_sync`, which keeps a per-index attempt cooldown -- how often ONE index is worth re-asking for, not which replica asks. |
| `google_places_instance_usage` | The month-by-month request count against the OPERATOR's Google Places key (`GOOGLE_PLACES_API_KEY`), which pays for every user's payee contact lookups. There is no owner column because there is no owner: one key is one bill, and a per-user copy could not enforce the one cap that matters. A user who configures their own key is counted in `payee_lookup_usage`, which is policied like any user-owned table. Written under system context by the quota claim; read only by the settings status. |
| `http_throttle_counters` | The HTTP throttler's counters in `CLUSTER_MODE=multi`. There is no owner column because there is nobody to own one: `ThrottlerGuard` is the first `APP_GUARD` and runs before `RequestContextInterceptor`, so the row is written before any identity exists, and the key is already `sha256(class-handler-throttler-tracker)` from the guard itself. An `UNLOGGED` table by design -- the rows are a cache the database itself truncates on crash recovery -- and excluded from the backup for the same reason. Written under system context by the storage; never read outside the statement that writes it. |
| `market_index_prices` | Global market reference data. A market index has no owner and nobody holds units of it, so one S&P 500 close serves every user. The alternative -- a per-user securities row per index -- would put a fake instrument in every holdings list and multiply provider traffic by the number of accounts. |
| `market_index_sync` | Sync bookkeeping for that refresh; same ownership story. |
| `oauth_instance_config` | The deployment's OIDC provider signing keys: one JWKS per Monize instance, generated on first start. There is no owner column because there is no owner -- one issuer signs ID tokens for every account, and a per-process key pair is the defect this table exists to close (two replicas serve two `/oauth/jwks` documents, so a client that fetched one rejects a token signed by the other, and a single pod does the same to itself across a restart). Written under system context by the provider's initialization, once, with the `INSERT` as the arbiter; `jwks_enc` is AES-256-GCM ciphertext under `ENCRYPTION_KEY` and is read only by `OauthSigningKeysService`. A deployment without that variable stores nothing here and keeps the per-process behaviour. |
| `oauth_payloads` | See section 3. |
| `provider_health` | Deployment-wide availability of an outbound market-data provider, plus the bookkeeping that keeps one outage to one alert. One Yahoo outage is every user's Yahoo outage: there is no owner column, and a per-user copy would multiply both the alert and the provider traffic by the number of accounts. Written under system context on transitions only, and read only by the alert sweep -- nothing user-identifiable is stored, and `last_failure_reason` is a network diagnostic, bounded on write. |
| `push_instance_config` | The deployment's Web Push identity: one VAPID key pair per Monize instance, generated on first start. There is no owner column because there is no owner -- one key pair signs for every account, and a per-user pair is exactly what discussion #1291 rejected (it would multiply the browser's subscription registrations by the number of accounts and gain nothing, since the push service authenticates the *sender*, not the recipient). Written under system context by the bootstrap hook and by an administrator's rotation; the private half is AES-256-GCM ciphertext under `ENCRYPTION_KEY` and is read only by `PushConfigService`. The subscriptions it signs for, `push_subscriptions`, are user-owned and carry the ordinary direct policy. |
| `schema_migrations` | Migration infrastructure, written only by `db-migrate` running as the owner. `INSERT`/`UPDATE`/`DELETE` are revoked from the runtime role (DR-02). |
| `update_check_state` | What this deployment last learned about the upstream GitHub release, and when it last asked. There is no owner column because there is no owner -- one instance checks one upstream, and the answer is the same for every account. It was a field on `UpdatesService`, which made two replicas answer `/updates` from two caches and made a restart re-ask GitHub, whose unauthenticated rate limit is per IP and shared by every replica behind one egress address. The row is also the claim: the refresh stamps `checked_at` in a conditional upsert and only its winner calls out. Written under system context by the 12-hour cron and the bootstrap hook; **read** under the caller's own identity on the request path, because the table is exempt and seeding a bypass there would widen the fence for nothing. |
| `single_use_tokens` | One-shot claims -- a TOTP code inside its reuse window, a confirmed AI action descriptor. The claim *is* the `INSERT`, so the winner is decided by the primary key rather than by a read the loser also passed, and that only works if every replica inserts into one table. `token_hash` is SHA-256 of the secret and never the secret: with no owner column every session can read this table, so what it holds must not be replayable. The `purpose` column keeps two unrelated one-shots from colliding on one hash. Swept daily. |

## 3. `oauth_payloads` and the OAuth adapter

### Context

`oidc-provider` needs durable storage for authorization codes, access and
refresh tokens, grants, sessions, interactions and device codes. Some of that
storage happens *before* Monize has an authenticated application user -- during
`authorize`, there is no session yet to derive an identity from.

`oauth_payloads` has no meaningful end-user ownership key. Rows are addressed by
opaque provider identifiers: `id`, `model`, `grantId`, `userCode`, `uid`. A
tenant policy would have no legitimate user predicate and would reduce to a
bypass-only arm -- a policy that reads as protection and provides none.

The provider is mounted as raw Express middleware in `backend/src/main.ts`,
outside Nest's request pipeline, so `RequestContextInterceptor` never sees these
calls.

### Decision

- `oauth_payloads` remains exempt from RLS.
- `PostgresAdapter` (`backend/src/oauth/postgres.adapter.ts`) may reach this one
  table directly through its injected `DataSource`.
- The runtime role keeps only the DML the adapter needs on this table.
- **This exception does not authorize direct `DataSource` access to any
  user-owned table**, and a new infrastructure table does not inherit it. A
  second such exception is a separate decision, documented here. There is now
  one other, and it is a different kind: section 4's notification connection
  reaches no table at all.

### What the safety argument actually is

Not identity context. The adapter runs with **no ambient context at all** --
neither a request scope nor `withSystemContext`.

This is worth stating plainly because the opposite was written down and believed
for a long time. Migration `114_rls_policies_special.sql`, its mirror at the
foot of `database/schema.sql`, the runbook's context table and the C1 task
record all asserted that access "runs under `withSystemContext` regardless".
None of it was true, and the claim mattered: it made the exemption look like a
consequence of an identity decision rather than what it is.

The safety argument is:

1. the table is RLS-exempt, so no policy is silently returning zero rows;
2. it has no owner column, so there is no tenant partition to cross;
3. rows are addressed by opaque, high-entropy provider identifiers;
4. the runtime role's grants on it are confined to the adapter's DML;
5. contents are short-lived and expire: every row the provider writes carries
   an `expires_at`, a dynamically registered client included (30 days from its
   last use, `OAUTH_CLIENT_IDLE_TTL_SECONDS`, #2177), and a daily sweep deletes
   what has passed it.

### The three permitted access paths

Exactly three, all in `backend/src/oauth/`:

1. **`PostgresAdapter`** -- `upsert`, `find`, `findByUserCode`, `findByUid`,
   `consume`, `destroy`, `revokeByGrantId`. Every one is keyed by an opaque
   provider identifier. `upsert` of a Grant or a RefreshToken also extends its
   own client's expiry, keyed by the `clientId` in the provider's payload.

2. **`OAuthProviderService.revokeAllForUser`** -- a single parameterized
   `DELETE` keyed on `payload ->> 'accountId'`, used wherever an account's
   credentials are replaced, so revocation takes effect immediately rather than
   at token-TTL expiry: the admin flows (deactivate, delete, password reset) and,
   through `revokeOAuthGrantsAfterCommit` (`backend/src/auth/credential-revocation.ts`),
   the emailed password reset, a password change, an owner's reset of a
   delegate's password, an emergency-access claim and an OIDC account-link
   confirmation.

   This one **is** keyed by an application user identifier, which the original
   rationale explicitly claimed never happened ("never queried per end-user").
   It is a bounded exception, not a defect: every caller derives the id on the
   server from something it has already verified -- the admin's target behind
   `@Roles("admin")`, the session's own subject, the row a single-use reset,
   claim or link token matched -- and never reads it from the request; and the
   statement deletes only rows whose own payload already names that subject.
   The id reaches the table only through this one method, never through a new
   query.

   It is deliberately **not** wrapped in `withSystemContext`. The table is
   exempt, so a bypass GUC would change nothing about what the query can reach
   -- it would buy the appearance of a control rather than a control, and widen
   the `WITH_CONTEXT_ALLOWLIST` fence for no gain. The real protection is the
   server-derived id, and saying so is more useful than dressing it up.

3. **`sweepOAuthPayloads`** (`postgres.adapter.ts`), run daily by
   `OAuthProviderService.sweepExpiredPayloads` (#2177) -- batched `UPDATE`s
   giving clients with no `expires_at` the idle TTL, then batched `DELETE`s
   whose only predicate is `expires_at` before this process's clock. Neither
   names an identifier, and the delete reaches only rows the provider already
   treats as absent. Not wrapped in `withSystemContext`, for the reason path 2
   is not.

Anything else is a defect. Both guards in section 5 fail on a path from any
other file.

### Rejected alternatives

1. **A policy consisting only of the system-bypass arm.** With no owner column
   there is no predicate to write, so the policy would be
   `USING (app_bypass_rls())` -- indistinguishable from exempt at runtime, but
   it would appear in `pg_policies` and read to any future reviewer as a table
   with tenant protection. An honest exemption with a written rationale is
   strictly better than a policy that lies.

2. **A dedicated owner-role `DataSource` for the OAuth module.** Considered at
   task C1 and declined. It buys nothing here -- the table is exempt either way
   -- and costs a second connection identity to audit, plus a second way to
   reach the database that the lint bans would then have to carve out.

3. **An artificial ownership column on short-lived provider artifacts.** The
   adapter would have to populate it before an identity exists, which is exactly
   the case that has none. It would be `NULL` for the rows that matter most.

4. **Wrapping every adapter operation in `withSystemContext` +
   `withScopedDb`.** This is the tempting one, because it makes the code *look*
   uniform. It would emit `app.bypass_rls` on a table with no policy to bypass:
   no behaviour change, a per-call transaction on the hot authorization path,
   and a fence entry implying a tenant decision nobody made. Uniformity of
   appearance is not the goal; an accurate boundary is.

### Consequences

- A defect in the adapter can affect the whole provider artifact store rather
  than one tenant's partition.
- Grant scope and the adapter's query keys are security-sensitive; the opacity
  of `id`/`grantId`/`userCode`/`uid` is load-bearing.
- `oauth_payloads` must not become general-purpose application storage.
- A schema change to the table requires a fresh ownership and RLS review.
- Another direct-`DataSource` exception requires its own entry in this document.

### Review triggers

Reconsider this decision when any of these happens:

- `oauth_payloads` gains `user_id`, `owner_user_id` or an equivalent tenant key;
- a query begins selecting rows by **request-supplied** application user input
  (the server-derived case in section 3 is the accepted bound,
  and is the reason this trigger is phrased that way);
- non-OAuth domain data is stored in the table;
- another module starts using `OAuthPayload`;
- the adapter receives an owner-role connection;
- another table requests the same exemption;
- the runtime role's grants on the table are widened.

## 4. The notification connection (`CLUSTER_MODE=multi`)

### Context

In `multi`, a replica has to be told that a row it is waiting on has changed:
the browser's SSE stream is held on one pod and the agent's answer arrives on
another. PostgreSQL carries that itself, with `LISTEN` and `pg_notify()`.

`LISTEN` is **session** state. The runtime pool may not hold session state --
that is the rule `common/db/advisory-locks.ts` already states for the lifecycle
lock, and a transaction-mode pooler in front of the database would drop it
anyway. So the subscription lives on its own connection, one per replica, for
the life of the process: `backend/src/common/cluster/pg-listener.provider.ts`,
bound as `PG_LISTENER` and `null` in `single`.

### Decision

- `PgListener` opens one `pg.Client` of its own, outside the TypeORM pool and
  outside `withScopedDb`.
- It connects with the **runtime role**, resolved by the same
  `resolveRlsDatabaseAuth` call that gives the pool its credentials. Neither
  `LISTEN` nor `pg_notify()` needs a privilege that role lacks, and the owner's
  credentials do not belong on a long-lived connection in the serving process.
- It runs `LISTEN <channel>` and `SELECT pg_notify($1, $2)`, and **nothing
  else**. No table, no view, no function that reads one.
- **This exception does not authorize reading or writing any table on that
  connection**, and it is not precedent for a second pooled-bypass path. A
  fourth entry in `direct-connection.guard.spec.ts` is a separate decision,
  documented here.

### What the safety argument actually is

Not identity context, and not an exemption. There is **no table**.

RLS is a per-row decision, so it needs a row. `LISTEN` registers interest in a
channel name; `pg_notify()` appends a string to a queue the server holds in
memory. Neither statement can name a relation, so no policy applies, and there
is nothing an identity GUC could change about what either one can reach.

That is the whole argument, and it is stronger than section 3's rather than
weaker: the OAuth adapter reaches a real table whose rows carry real secrets and
relies on the table being exempt and its keys opaque. This connection cannot
reach a row at all.

What it *can* do is carry a message between replicas outside every fence. That
is why the payload rule is a rule and not a convention: **a notification says
which row to look at, never what the row says.** The recipient reads that row
back under its own scope, through `withScopedDb`, where the tenant decision is
made as usual. A payload carrying data would hand one replica a value no policy
ever authorized it to see, and `common/events/event-bus.interface.ts` states the
rule where the code that would break it lives.

Two smaller consequences of being outside a transaction, both deliberate:

- A `pg_notify()` on this connection is **not** rolled back by the transaction
  that triggered it, which is exactly why it is issued after the commit. Sent
  from inside, a rollback would wake a reader to a row that never existed.
- A wake-up can be **lost** -- one sent while this connection is reconnecting
  reaches nobody, and PostgreSQL acknowledges no delivery. Every waiter also
  polls on a slow timer, so the notification only shortens the wait. Readiness
  reports the connection's state so a replica that cannot hear leaves the load
  balancer rather than holding streams that advance only on the poll.

### Rejected alternatives

1. **`LISTEN` on a pooled connection.** The pool hands the next statement to
   whichever connection is free, so the subscription would land on one
   connection and the reader on another. It also puts session state on the pool,
   which the RLS design forbids outright, and a transaction-mode pooler would
   lose it silently -- the failure being wake-ups that never arrive, which reads
   as a slow application rather than a broken one.

2. **Routing `pg_notify()` through `withScopedDb`.** Tempting, because it would
   make the code look uniform. It would open a transaction to run a statement
   that cannot touch a row, emit identity GUCs for a tenant decision nobody is
   making, and -- worse -- put the notify inside a transaction that can roll
   back while the reader has already been woken. Uniformity of appearance is not
   the goal.

3. **The owner's credentials for this connection.** Rejected for the reason the
   runtime role exists: a long-lived connection in the request-serving process
   is the last place to hold credentials that bypass every policy, and this one
   needs none of that privilege.

4. **A second stateful service for the channel.** An earlier draft of the
   horizontal-scaling plan reserved an optional Redis for exactly this message.
   Rejected, and recorded in the plan: another store to run, back up, secure and
   probe, for a channel PostgreSQL already has. See
   `docs/specs/horizontal-scaling.md`.

### Review triggers

Reconsider this decision when any of these happens:

- the listener connection runs any statement other than `LISTEN`, `UNLISTEN` or
  `pg_notify()`;
- a notification payload begins carrying data rather than identifiers;
- a second long-lived direct connection is proposed for anything;
- the connection is given the owner's credentials;
- the runtime role's privileges are narrowed to where `LISTEN` or `pg_notify()`
  is refused.

## 5. Adding or exempting a table

Adding a **user-owned** table: ship its `CREATE POLICY` in the same migration,
and -- for any migration numbered after `123` -- its own `ALTER TABLE ... ENABLE
ROW LEVEL SECURITY`. `database/CLAUDE.md` has the rules and the worked examples.

**A read arm never goes into `WITH CHECK`.** A policy whose `USING` admits a
second party (a delegate's `app.real_user_id` arm, a joint read arm) states its
`WITH CHECK` separately, naming only the identity that may create the row: one
expression for both let a delegate-side session issue itself a delegation from
any owner (A26-M06). `account_delegates` and `account_delegate_grants` admit a
write only from the owner's own session (`current = real = owner`), and a grant
only over the owner's own account, checked through the SECURITY DEFINER
`delegation_grant_account_is_owners` because a policy on the grants cannot read
`accounts` (the accounts policy reads the grants, and PostgreSQL refuses the
cycle as infinite recursion). Migration `20261022142820`; the cases are in
`rls-enforcement.integration.spec.ts`, "delegation rows are issued by the owner
only".

Exempting a table is a deliberate decision, and takes four things in one change:

1. an entry in `RLS_EXEMPT_TABLES` with a one-line reason;
2. an `-- rls-exempt: <table>` marker in `database/schema.sql`;
3. a row in the section 2 table above, with the real rationale;
4. a reason it is not one of the other three buckets.

## 6. What is enforced, and where

| Guard | Fails when |
|---|---|
| `backend/src/common/db/rls-exempt-tables.spec.ts` | The constant and the schema marker block disagree in either direction, or the marker block is missing. No database needed. |
| `backend/src/oauth/oauth-payload-access.spec.ts` | A production file outside the allowlist names `OAuthPayload` or `oauth_payloads` -- including via a re-export or raw SQL, which the lint ban cannot see. Also fails when an allowlist entry goes stale, and when the adapter loses its pointer to this document. |
| `OAUTH_PAYLOAD_ALLOWLIST` in `backend/eslint.config.mjs` | A production file outside the allowlist imports the entity. |
| `WITH_CONTEXT_ALLOWLIST` in `backend/eslint.config.mjs` | A new file imports `withSystemContext` / `withUserContext` without being added as a reviewed decision. |
| `backend/test/integration/rls-enforcement.integration.spec.ts` | A table is in no bucket or several; a covered table lacks its policy; an exempt table has one. Live PostgreSQL. |
| `backend/test/integration/rls-enable.integration.spec.ts` | Migration `123` enables RLS on an unpolicied table, or misses a policied one. Live PostgreSQL. |
| `backend/src/common/db/lint-bans.spec.ts` | A banned database primitive is not documented where contributors read, or an instruction file recommends one. |
| `backend/src/common/db/direct-connection.guard.spec.ts` | A file under `src/` builds a `pg` `Client` or `Pool` outside the allowlist (the three pre-boot scripts and the section 4 listener), or an allowlist entry has gone stale. No database needed; ESLint cannot see this, because `pg` is a legitimate import. |

The two ESLint allowlists are deliberately *not* one list: they answer different
questions, and `backend/src/oauth/oauth-provider.service.ts` is legitimately on
both. Flat config replaces a rule's whole options object per block, so each
override restates the bans it does not mean to lift -- see `importRule` in
`backend/eslint.config.mjs`, and the block covering the intersection.

One ban that is deliberately absent: there is no `no-restricted-syntax` selector
on `getRepository`. `m.getRepository(X)` off a scoped `EntityManager` is the
correct pattern throughout this codebase, so such a selector would fire on
hundreds of correct call sites -- and `lint-bans.spec.ts` scrapes selector shapes
out of the config and requires `AGENTS.md` and `CONTRIBUTING.md` to name
each banned call, which would put actively false guidance in the instruction
files. The restriction is on the import, where it can be stated truthfully.


`push_chart_artifacts` is ephemeral deployment infrastructure, not an owner-queryable
resource. Only a valid short-lived HMAC bearer token authorizes its atomic
DELETE RETURNING download. Tokens are minted by owner-scoped opted-in push
fan-out, independently per device; the table is capped and excluded from backups.
