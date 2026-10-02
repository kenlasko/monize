# Concurrency and Idempotency Contract

A transaction is not a concurrency protocol. `withScopedDb` gives every write
atomicity and a tenant identity, and that is genuinely valuable -- but two
transactions that are each individually correct can still corrupt a shared value
if they disagree about how they serialize against each other. Most of the
concurrency defects found in this codebase were not missing transactions. They
were writers of the same value using *different* protocols.

This document defines which protocol to use when, and records which protocol
each existing writer actually uses. Where two writers of the same value disagree,
that is recorded as a gap rather than smoothed over -- see section 8.

Related: `AGENTS.md` (Transactions, Database Access) states the rules for
reaching the database at all; `docs/financial-calculation-contract.md` section 7
states that a rejected command must not already have written.

## 1. The primitive, and what it does and does not give you

```typescript
withScopedDb<T>(
  dataSource: DataSource,
  fn: (manager: EntityManager) => Promise<T>,
  isolation?: ScopedDbIsolation,
): Promise<T>
```

What it guarantees (`backend/src/common/db/scoped-db.ts`):

- One transaction, committed when the callback returns, rolled back when it
  throws.
- The tenant GUCs (`app.current_user_id`, `app.real_user_id`, or
  `app.bypass_rls`) are set as the transaction's first statements using
  `set_config(..., true)`, so they are transaction-local and cannot leak onto a
  pooled connection.
- It **throws** without an ambient identity context rather than silently falling
  back to `dataSource.manager`.
- A nested call **joins** the ambient transaction -- same connection, same
  atomicity -- so a service method calling another does not deadlock the pool.
  Requesting an `isolation` level while joining throws instead of silently
  downgrading.

What it does **not** give you:

- **Any protection against a concurrent writer of the same row.** The default
  isolation is READ COMMITTED. Two transactions may both read a value, both
  compute a new one from it, and both write; the second overwrites the first.
  Nothing in `withScopedDb` prevents that, and nothing warns about it.
- **Any ordering.** Two transactions touching two rows in opposite order can
  deadlock; the primitive has no lock-ordering opinion.

`runOutsideActiveScopedManager(fn)` deliberately escapes the ambient
transaction so a write inside becomes visible before the outer transaction
commits. It costs an extra pooled connection for its duration and is correct
only for a short statement at a phase boundary -- a progress or heartbeat write
a concurrent poller must see. It is never correct per row.

## 2. Choosing a mechanism

Work down this list and stop at the first row that applies. The ranking is by
how much the database enforces rather than the caller.

| # | Situation | Mechanism |
| --- | --- | --- |
| 1 | The new value is a function of the old value of **one column** | Atomic SQL arithmetic: `SET col = col + $1` |
| 2 | At most one row may exist for a key | `UNIQUE` or partial unique index, and handle `23505` |
| 3 | A state transition must have exactly one winner | `UPDATE ... WHERE <expected state> RETURNING id` |
| 4 | An upsert whose losing side must still see the winner's rows | `ON CONFLICT ... DO UPDATE`, then re-read inside the same transaction |
| 5 | Several columns or rows must be read, decided on, and written together | `SELECT ... FOR UPDATE` on the row that owns the decision |
| 6 | The resource is not a row (a whole computation, a materialization) | `pg_advisory_xact_lock` |
| 7 | A cross-request business operation must not repeat | A persisted idempotency key, written before the effect |

Rows 1-4 are enforced by the database and survive a caller who forgets. Rows
5-7 depend on every writer taking part, which is why they need the inventory in
section 8: a lock that one of three writers skips is not a lock.

### 1 -- atomic arithmetic

```sql
UPDATE accounts SET current_balance = ROUND(CAST(current_balance AS numeric) + $1, 4) WHERE id = $2
```

`backend/src/accounts/accounts.service.ts` `updateBalance`. Correct and
lock-free: the read and the write are one statement, so no other transaction can
interleave between them. Prefer this whenever the update is expressible as a
delta.

The import's per-row balance write is the same statement, issued on the import
transaction's `EntityManager`:
`backend/src/import/import-context.ts` `updateAccountBalance`, the one door the
QIF, OFX, CSV and investment processors move a balance through. The delta it
passes is rounded with `roundMoney` (4dp, the column's precision) and the sum is
rounded by the database. `backend/test/integration/import-balance-delta.integration.spec.ts`
holds both halves: an import's amounts land at 4dp, and two deltas on two
connections compose rather than one overwriting the other.

### 2 -- unique index as the guarantee

```sql
CREATE UNIQUE INDEX idx_import_jobs_one_active_per_user
  ON import_jobs (user_id) WHERE status IN ('pending', 'running');
```

`database/schema.sql`. This is the codebase's best example of the rule in
CONC-002 below, and `schema.sql` says why in the index's own comment: it is
enforced there "rather than by a read-then-insert in the service: two concurrent
starts would otherwise both see no active job."

The application still needs to translate the violation. `MnyImportJobService`
does it with `isActiveJobConflict()`, matching on both SQLSTATE `23505` and the
constraint name, and returning the same `409` the advisory pre-check would have
returned. The pre-check is kept for a good error message and is documented as
advisory only -- it "answers the question a moment before the answer can change."

### 3 -- conditional update as the claim

```typescript
// mny-import-job.service.ts, claim()
UPDATE import_jobs SET status = 'running', ... WHERE id = $1 AND status = 'pending' RETURNING id
```

The `WHERE status = 'pending'` *is* the concurrency control: whichever statement
commits first updates one row, the other updates none. The caller decides it won
by whether a row came back.

**The trap that has already bitten here:** a data-modifying statement with
`RETURNING` comes back from `manager.query()` as `[rows, rowCount]`, while a
bare `SELECT` comes back as plain rows. Reading the tuple as `rows.length > 0`
makes *every* attempt look like a winner. `returnedRows<T>()` in
`mny-import-job.service.ts` exists for exactly this, and its comment records
that the bug was found by the real-database concurrency spec -- not by the unit
tests. Use the helper; never destructure a `RETURNING` result by hand.

### 4 -- upsert on a natural key

```sql
INSERT INTO exchange_rates (...) VALUES (...)
ON CONFLICT (from_currency, to_currency, rate_date) DO UPDATE SET rate = EXCLUDED.rate
```

The cheapest idempotency available, because the uniqueness is a property of the
data rather than something invented and remembered. A repeated or concurrent
refresh converges instead of duplicating. `security_prices` uses the same shape
on `(security_id, price_date)`.

The caveat is about reading afterwards, not writing: an operation that uses
`ON CONFLICT DO NOTHING` and then returns a read model must re-read the
authoritative state inside the same transaction. The request that lost the race
would otherwise return a snapshot taken before the winner's rows existed. See
`docs/financial-calculation-contract.md` section 6.

### 5 -- pessimistic lock

```typescript
manager.findOne(RefreshToken, {
  where: { tokenHash },
  lock: { mode: "pessimistic_write" },
});
```

TypeORM's `pessimistic_write` compiles to `FOR UPDATE`. It is the right tool
when the decision needs more than one column, or spans rows, and cannot be
folded into a single conditional statement.

There are exactly five such sites in `backend/src` today (four row locks and one
advisory lock); they are listed in section 8. That number is small enough that a
new one is a reviewable decision, and it should stay that way.

### 6 -- advisory lock

```typescript
await manager.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [strategyId]);
```

`backend/src/strategies/gem-signal.service.ts`. The locked thing is not a row --
it is "materializing a signal for this strategy". `pg_advisory_xact_lock`
releases on commit or rollback and is cluster-wide, so unlike a Node-level mutex
it works across replicas. Use it when the resource is a computation rather than a
record, and always the `_xact_` variant so a crash cannot hold the lock.

### 7 -- persisted idempotency key

The last resort, for an effect that cannot be folded into one transaction and has
no natural key to upsert on. It is last because it is the only mechanism on this
list whose correctness depends on constructing the key well, and a key derived
from the wrong thing provides no protection while looking like it does. Section 6
below has the construction rules.

A `Set` in process memory is not a substitute for any of the above. It
coordinates one replica with itself and silently does nothing across the two or
more replicas this application actually runs.

## 3. Normative rules

```text
CONC-001
A value used to compute a destructive or financial write must be read inside the
same transaction and under the same lock, statement, or version guard that
authorizes the write. A value read before the transaction is a snapshot, and a
write derived from a snapshot silently discards whatever committed in between.

CONC-002
A check followed by an insert is not an exclusivity mechanism. Exclusivity is
enforced by a database constraint or a single atomic statement. A pre-check may
exist for a better error message, and must be commented as advisory.

CONC-003
All writers of the same derived value must use one serialization protocol. An
atomic delta and an absolute recomputation are not compatible: the recomputation
overwrites the whole column, so a delta that commits between its read and its
write is lost. Either every writer holds the same lock, or every writer is a
delta, or the recomputation is the only writer.

CONC-004
Every scheduled or background operation with a persistent, user-visible, or
external effect must have a durable logical-operation key -- a row whose
existence means "this effect has happened" -- and must claim it atomically.
"Two replicas run this and the second one's writes are harmless" is a claim that
requires proof, not an assumption.

CONC-005
A worker may write progress, complete, fail, or reap a job only while its claim
still holds. A stale worker that wakes after being reaped must not be able to
mark a newer generation of the same job complete.

CONC-006
A retry after an unknown commit result must reconcile durable state. It may
repeat an operation only if repeating it is provably idempotent -- because the
whole effect was one transaction, because the write is an upsert on a natural
key, or because a persisted key blocks the second attempt.

CONC-007
A comment claiming atomicity, a lock, or single-use consumption must name the
mechanism. Two comments in this codebase claimed a guarantee the code beside
them did not implement, and both were believed for as long as they existed. If
the mechanism cannot be named, the comment is wrong, not merely vague.
```

## 4. Retry semantics

The three cases are genuinely different and must be distinguished before writing
a retry:

| When the failure happened | What a retry means |
| --- | --- |
| Before commit | Nothing was written. A retry is a fresh attempt and needs no protection. |
| After commit, response lost | The effect happened. A blind retry duplicates it. The retry must reconcile: read the durable state and continue from it. |
| Commit result unknown | Treat as "after commit" until proven otherwise. This is the case CONC-006 exists for. |

Whole-effect-in-one-transaction is the strongest position available for the first
case, because there is no key to construct wrongly -- prefer it wherever the
effect genuinely fits in one transaction.

**The trap is the word "genuinely", and the MNY import is the worked example of
falling into it.** `writeAll` puts every business row in one `withScopedDb`
transaction, which is real and correct. But the import is not over when that
transaction commits: post-processing, verification, holdings verification,
staged-file deletion and the terminal job-status update all follow it. So a
failure lands in the *first* row of the table above only if it happened inside
`writeAll`; a failure after that commit is squarely in the second row, and the
import has no mechanism for it -- no data-committed checkpoint, no import-run id,
and fresh UUIDs on every parse. A retry replays.

The comment above `runImport` says "The whole write is one transaction, so a
failure leaves nothing behind and Retry cannot double-import." Read carefully,
the first clause describes `writeAll` and the second describes the import; the
inference between them is where the guarantee is lost. That is CONC-007's exact
failure mode -- a named mechanism that does not cover the scope claimed -- and it
is worth knowing that this document asserted the same thing in an earlier
revision, having taken the comment at its word.

So before claiming this pattern: check that the transaction's boundary and the
operation's boundary are the same boundary. If anything happens after the commit
that the caller would consider part of the operation, the operation is in the
second row of the table and needs reconciliation. See INV-IMPORT-002.

The exchange-rate and security-price refreshes are the model for repeatable
writes: `ON CONFLICT (from_currency, to_currency, rate_date) DO UPDATE` and
`ON CONFLICT (security_id, price_date) DO UPDATE` make a repeated fetch
converge instead of duplicating. Note the interaction with
`docs/financial-calculation-contract.md` section 6: an operation that uses
`ON CONFLICT DO NOTHING` and then returns a read model must re-read the
authoritative state inside the same transaction, because the request that lost
the race would otherwise return data missing the winner's rows.

## 5. Lock ordering

Deadlock is prevented by every transaction taking locks in the same order, and
the only order that is stable across a codebase is a global one. Where more than
one row must be locked:

1. Accounts before transactions before splits.
2. Within one kind, ascending by `id`.
3. A transfer locks both legs in ascending account id, never "source then
   destination" -- the two legs of a reciprocal pair would otherwise take them
   in opposite orders.

This ordering is a rule this document introduces rather than one the code
currently demonstrates: no existing site locks two rows of the same kind. It
applies from the first one that does.

**Advisory locks come before row locks, and holdings are the case that proves
it.** Every writer of a position takes `lockHoldingScope` (`common/db/locks.ts`,
`LockScope.Holdings`, keyed by account) as the *first statement* of its
transaction, naming every account whose position the transaction will re-derive:
`InvestmentTransactionsService.create`, `update`, `remove`, `updateStatus`,
`transferSecurity` and `createEmbeddedForSplit`, as well as
`HoldingsService.rebuildScopesFromTransactions` itself. A ledger write that
waited until the rebuild at the end of its transaction had already row-locked
`accounts` for its cash effects, which is the opposite order from a split status
change reaching the same rows (`applyParentStatusToEmbeddedRows` takes the
advisory lock first, then row-locks the legs): two concurrent writers of one
account can then hold each other's next lock, and PostgreSQL breaks the cycle
with `40P01` on one of them. `pg_advisory_xact_lock` is re-entrant within a
transaction, so the opening call never double-acquires and the rebuild's own call
stays where it is -- a rebuild reached from anywhere else still takes it before
reading the ledger.

The same obligation falls on the paths that reach a position *through* something
else, because each of them row-locks the split parent, `accounts`, or both on the
way:

- **A split parent's status change.** The reconciliation, bulk and generic
  `TransactionsService.update` routes all
  row-lock the parent (`lockTransactionRow` / `lockTransactionRows`) and then
  row-lock `accounts` for its balance, while `InvestmentTransactionsService`
  reaches the same parent the other way round -- `lockHoldingScope` first, then
  `updateEmbeddedSplitParent`'s `lockTransactionRow` on that parent. So
  `TransactionSplitService.lockEmbeddedInvestmentScopes` (which delegates to
  `InvestmentTransactionsService.lockEmbeddedHoldingScopes`) is the **first
  statement** of each split-status transaction, before the parent's row lock and
  not merely before its balance write: an advisory lock taken between the two
  row locks still leaves advisory-A-then-row-P racing row-P-then-advisory-A,
  which is `40P01` for both. The helper's own `SELECT` of the brokerage accounts
  is unlocked, so it may precede the advisory lock, and the call is
  unconditional on the reconciliation and generic-update routes because whether
  the row is a split parent cannot be known without locking it -- a row with no
  embedded investment legs locks nothing. The generic route reaches the advisory
  lock by three further ways besides the status propagation --
  `deleteSplitSideEffects`, `createEmbeddedForSplit` and the rebuild each take
  it -- which is the same cycle and the same first statement.
  `applyParentStatusToEmbeddedRows` takes the same re-entrant lock itself, so a
  caller that forgets still cannot reach the rebuild without it.
- **A split set replaced.** `TransactionSplitService.updateSplits` is the same
  cycle without a status change: it row-locks the parent, then tears the
  existing embedded investment rows down (`deleteSplitSideEffects` ->
  `reverseAndRemoveEmbedded` -> the rebuild) and builds the new ones
  (`createEmbeddedForSplit`), each under the holdings advisory lock. It takes
  `lockEmbeddedInvestmentScopes` as the first statement of its transaction for
  the same reason, and `createEmbeddedForSplit`'s own call is then the re-entrant
  one. `addSplit` refuses an investment split outright and reaches no advisory
  lock, so it needs none. A brokerage account only the incoming splits name is
  not locked up front: no committed embedded row of that parent sits in it, so
  no transaction can hold that account's advisory lock while waiting for this
  parent's row.
- **An import.** `ImportService` takes `lockHoldingScope` over every investment
  account the user already has as the first statement of both import
  transactions, because the accounts the file turns out to touch are discovered
  as it is read and the per-row balance writes row-lock `accounts` long before
  `rebuildImportedHoldings` runs. Accounts the import creates inside its own
  transaction are covered by the rebuild's call: no other transaction can see
  them, so nothing can be holding their lock.

## 6. Idempotency keys

When a key is genuinely needed (the effect cannot be folded into one
transaction, and no natural key exists), it must be:

- **Derived from the logical operation, not the request.** For a scheduled
  occurrence: `(scheduledTransactionId, occurrenceDate)`. For a daily digest:
  `(userId, kind, date)`. A UUID generated by the caller identifies a *retry
  attempt*, not an operation, and two independent retries would get two keys.
- **Persisted before the effect**, in the same transaction that will be checked
  by the next attempt.
- **Unique in the database.** A key checked with a `SELECT` and inserted
  afterwards is CONC-002 again, one level up.

## 7. Multi-replica cron requirements

Every `@Cron` handler runs in **every** backend replica -- there is no separate
scheduler process. `docs/cron-jobs.md` states this and lists the jobs; what it
must also record, per job, is the answer to one question:

> What prevents two healthy replicas from producing the same effect twice?

The acceptable answers are: a conditional claim, a unique constraint, an
advisory lock, or a proof that the operation is idempotent by construction.
"The window is small" is not one of them; nor is a process-local `Set`.

Idempotent-by-construction is a real answer and several jobs legitimately use
it, but it must be argued rather than asserted. `DELETE ... WHERE expired`
qualifies because the predicate is "already expired", so a second sweep matches
nothing new. An absolute recomputation qualifies against *another copy of
itself*, and not against a concurrent delta -- which is CONC-003, and is why
the account-balance cron appears in the gap register below despite being
correctly documented as idempotent with respect to re-running.

## 8. Mechanism inventory and gap register

This is the part of the document that goes stale fastest, and the part most
worth keeping: CONC-003 can only be checked against a list of all writers.

### Locks that exist

| Site | Resource | Why |
| --- | --- | --- |
| `auth/token.service.ts` `refreshTokens` | `RefreshToken` row by `tokenHash` | Two concurrent rotations of one token |
| `auth/two-factor.service.ts` | `User` row during backup-code consumption | Same code consumed twice |
| `accounts/accounts.service.ts` `update` | `Account` row | Concurrent balance modification |
| `accounts/accounts.service.ts` `close` | `Account` row | Race between the balance check and the close |
| `strategies/gem-signal.service.ts` | advisory, per `strategyId` | Materialization interleaving with a settings save |
| `securities/investment-transactions.service.ts` `create`, `update`, `remove`, `transferSecurity`, `createEmbeddedForSplit` | advisory, per account (`lockHoldingScope`), first statement of the transaction | A ledger write and a rebuild racing on one position, and the lock order that keeps it deadlock-free |
| `transactions/transaction-reconciliation.service.ts`, `transactions/transaction-bulk-update.service.ts`, `transactions/transactions.service.ts` `update`, `transactions/transaction-split.service.ts` `updateSplits` (split-parent writes) | advisory, per brokerage account (`lockEmbeddedInvestmentScopes`), first statement of the transaction | The embedded rows' rebuild takes the same lock, and an investment write row-locks the same parent after taking it |
| `import/import.service.ts` | advisory, per investment account (`lockHoldingScope`), first statement of the import transaction | The import's balance writes row-lock `accounts` before `rebuildImportedHoldings` |
| `transaction-rules/transaction-rules.service.ts` `create`, `update`, `setEnabled`, `remove`, `reorder` | advisory, per user (`lockTransactionRuleList`), first statement of the transaction | Create's `max + 1` position, the per-user cap, delete's compaction and reorder each read the whole rule list before writing it; the deferred unique `(user_id, position)` is the backstop |
| `bank-sync/bank-sync-writer.service.ts` `write` | `bank_sync_accounts` row `FOR UPDATE`, then the Monize account (`lockAccountsForBalanceWrite`) | Two syncs of one bank account serialize, and a re-link or a new cut-off date committed during the fetch is seen before any row is written |
| `transaction-rules/transaction-rules-run.service.ts` `run` | `transaction_rules` row `FOR SHARE`, then the candidate `transactions` rows (`lockTransactionRows`, ascending id) | A rule edit waits for a run on it, and the rows are re-read and re-planned under the lock before the fingerprint is compared; the run takes no advisory lock and no account lock |

### Conditional claims that exist

`mny-import-job.service.ts` `claim` and `reapStaleJobs`; the sibling-token
voiding in the three emergency-access call sites; the emergency-access claim
consumption itself (`emergency-access-claim.controller.ts` `complete`), a
single `UPDATE emergency_access_contacts ... WHERE claim_token_hash = $1 AND claim_token_used_at IS NULL AND claim_token_expires_at >= CURRENT_TIMESTAMP RETURNING`
run before any credential is touched, so the loser of two concurrent completes
gets zero rows and is refused having written nothing (INV-CLAIM-001; the
two-connection test is still owed); the Google Places monthly quota
claim (`payee-lookup-quota.service.ts`, INV-PAYEE-002), whose conditional
`ON CONFLICT DO UPDATE ... WHERE requests < cap` is both the increment and the
limit, so no caller ever reads a count it then writes back. Its compensating
`release` is deliberately NOT conditional: it is a `GREATEST(x - 1, 0)` applied
after an answered refusal, and the floor is what keeps a release that crossed a
month boundary from minting quota rather than returning it. The bank sync consent callback
(`bank-sync-connections.service.ts` `completeCallback`) claims its connection
with one `UPDATE bank_sync_connections SET auth_state_hash = NULL ... WHERE
user_id = $1 AND auth_state_hash = $2 AND auth_started_at > now() - ttl
RETURNING`, so a replayed or concurrent callback gets zero rows and is refused
having written nothing; the bank sync ledger insert
(`bank-sync-writer.service.ts`, INV-BANKSYNC-001) is mechanism 2, an
`ON CONFLICT DO NOTHING RETURNING` on the unique `(account_id, external_key)`
run before the transaction row it guards. There is no `@VersionColumn`
anywhere in the codebase -- conditional `WHERE` is the whole of its optimistic
concurrency control.

The failed-login counter is the codebase's one use of mechanism 1 on a column
the security model reads. `recordFailedLogin` (`backend/src/auth/login-lockout.ts`)
is a single `UPDATE users u SET failed_login_attempts = u.failed_login_attempts + 1,
locked_until = CASE WHEN ... END FROM prev WHERE u.id = prev.id RETURNING`, so the
increment and the lockout decision it feeds are one statement over one row: the
threshold is evaluated on the value the database just wrote, never on one read
before the bcrypt compare. The `prev` CTE carries the pre-update `locked_until`
out in the same `RETURNING` so the caller can tell "locked now" from "already
locked" without a second read. INV-AUTH-002.

Two jobs this register once listed as gaps are claimed, and are listed here
instead. Scheduled auto-posting (`scheduled-transactions.service.ts` `post`,
reached by the hourly cron and by a manual post alike) claims the occurrence
with `INSERT INTO scheduled_transaction_postings ... ON CONFLICT (scheduled_transaction_id, original_due_date) DO NOTHING RETURNING id`
inside the transaction that writes the money, so the unique key from migration
140 is the serialization point and the losing replica's `ConflictException` is
counted as a skip, not an error (INV-OCCURRENCE-001). The cron passes the
occurrence it selected as `expectedDueDate`, because the claim key is only as
good as the date it is built from: a replica that re-read the schedule after the
winner advanced it keyed the claim on the next occurrence and posted that. The demo reset
(`backend/src/database/demo-reset.service.ts`) takes
`claimOnce(JobClaimType.DemoReset, demoUserId, "reset:<UTC day>")` before the
wipe-and-reseed. The claim is permanent, so it records "reset today" as well as
"running now": a replica whose tick arrives after the first has finished skips
rather than wiping a freshly seeded demo. It is deliberately not released on
failure -- a partial reset beats a doubled one -- so a replica killed mid-reset
leaves the demo as it is until the next UTC day's key.

The monthly budget rollover (`budget-period-cron.service.ts`) claims
`claimOnce(BudgetPeriodRollover, ownerUserId, "<YYYY-MM>")` inside each owner's
`withUserContext` before touching that owner's budgets, so a losing replica
skips the owner rather than racing it budget by budget. The claim is per owner
because `job_claims.user_id` is a `NOT NULL` foreign key to `users` -- there is
no deployment-wide claim through `JobClaimService` -- and per owner is also the
unit the rollover works in. It is **not** the record that the rollover happened
-- section 6's rule, and `JobClaimService`'s own header -- so the cron hands it
back with `releasePermanentClaim` whenever the owner's pass did not complete,
which is any budget of theirs that failed with something other than
`NoOpenPeriodError`. Handing it back cannot roll a month over twice: the
guarded writes underneath are what enforce "once", and a second pass over an
owner already rolled over finds no expired OPEN period and does nothing. Those
writes stay exactly as they were, as the second wall: `closePeriod` locks the OPEN period row, and the next period is
`ON CONFLICT (budget_id, period_start) DO NOTHING RETURNING`. What the claim
changed for the report is that a loser no longer reaches `closePeriod` at all,
and the residual case -- two processes on one replica during a rollout -- raises
a named `NoOpenPeriodError` the cron counts as a skip rather than as a failure.

### Gaps

Each row is a place where the rules above are not currently met. A row leaves
this table when a mechanism lands, not when someone judges the window small.

| Value or operation | Current state | Rule breached |
| --- | --- | --- |
| `accounts.current_balance` | Three postures coexist on one column: a lock-free atomic delta (`updateBalance`, `import-context.updateAccountBalance`), an unlocked read-then-write absolute recompute (`recalculateCurrentBalance`, the hourly `applyDueTransactionBalances`, `import-post-processing`, `write-transactions`, `action-history.recalculateBalance`), and a pessimistically locked read-then-write (`update`, `close`). A delta committing between a recompute's SELECT and its UPDATE is silently discarded. | CONC-001, CONC-003 |
| `holdings.quantity` / `average_cost` | Every mutation path is a JavaScript read-modify-write inside a transaction with no lock and no atomic delta. `UNIQUE(account_id, security_id)` prevents duplicate rows and does nothing about a lost update to the same row. | CONC-001 |
| Budget rollover after a failed owner pass | The claim is handed back, so a failure is no longer recorded as a success -- but nothing re-runs it inside the month. `budget-period-cron` is `0 0 1 * *`, so there is no later tick, and the request path has no repair: `getOrCreateCurrentPeriod` has **no production caller**, and would return a previous month's still-OPEN period unchanged if it had one. The owner's previous period therefore stays OPEN until the next month's tick, which closes it and creates the month it runs in -- skipping the month that was missed. Closing it needs either a request-path repair with a caller, or a tick frequency that gives the claim somewhere to be retried. | CONC-006 |
| Logout vs rotation | Logout's family revoke is an unlocked bulk `UPDATE`. It happens to be safe because `isRevoked = true` is idempotent and the end state is order-independent -- but this is a property of the value, not a protocol, and it stops holding the moment logout writes anything else. | CONC-003 (tolerated; document, do not copy) |
| MNY import retry after a committed write | `writeAll`'s transaction commits before post-processing, verification, staged-file deletion and the terminal status update. A failure in that window leaves committed rows behind a retryable job, and a retry re-parses with fresh UUIDs. No checkpoint, run id, or per-record key. See INV-IMPORT-002. | CONC-006, CONC-007 |

Refresh-token rotation is worth reading as a positive finding rather than a gap:
it is correct and subtle -- the loser blocks on the lock, then sees the winner's
committed `isRevoked`, and takes the reuse-detection branch that revokes the whole
family, so a concurrent double-rotation ends in revocation rather than two live
successors.

The MNY import job deserves a more careful verdict than either column allows. It
has the most complete protocol in the codebase for the races it was built to
handle -- a partial unique index for exclusivity, a conditional claim for the
worker, a heartbeat with a reaper for a dead worker -- and it is the only workflow
with real two-connection tests. Those two facts are related, and the tests are why
the `returnedRows` bug was found. What it does not have is a protocol for the
window *after* its own write commits, which is the row added above. A workflow can
be the best-defended one in a codebase against the failures it anticipated and
still be undefended against the one it did not.

## 9. Test obligation

A concurrency mechanism that has only unit tests has not been tested. A mocked
repository can be made to return whatever the "lost the race" branch needs,
which makes that branch testable, tested, and dead -- the `returnedRows` bug
above survived exactly that way, and `gem-price.integration.spec.ts` records the
same lesson: with a mock, "every lost-race branch was dead, tested and
unreachable."

Anything claiming a property of PostgreSQL -- statement snapshots, row-lock
ordering, partial-index arbitration, one-winner CAS -- needs a test that opens
two real connections and interleaves them.
`backend/test/integration/mny-import-job.integration.spec.ts` is the pattern to
copy; it states its own rationale: these are "properties of Postgres, not of the
service". `docs/verification-contract.md` records which invariant requires
which kind of test, and `docs/testing-contract.md` section on asynchronous and
concurrent operations lists the interleavings to pick from.
