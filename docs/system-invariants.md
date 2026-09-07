Direction           Bill or deposit, outflow or income, is decided from
                    EffectiveScheduledOccurrence.directionAmount, which is
                    `number | null`: the occurrence's own amount when known, the
                    snapshot's sign only where that sign is PROVABLE without the
                    missing rate (a top-level investment is one scalar times one
                    positive rate; a split whose lines all point the same way
                    stays on that side of zero, because an investment line's cash
                    impact is signed by its action), and `null` for a mixed-sign
                    aggregate, whose direction the missing rate decides. "An
                    exchange rate is positive, so it cannot flip a sign" holds for
                    the first two and fails for the third: a +10 parent made of a
                    fixed +100 beside an unpriceable BUY posts -20 or +20.
                    `null` travels rather than collapsing: AI/MCP report
                    `kind: "unknown"` and withhold BOTH bucket totals (the item
                    could belong to either), the reminder email draws a neutral
                    badge, the forecast prompt says DIRECTION UNKNOWN, the client's
                    occurrenceKind answers `'unknown'` with neutral styling and no
                    sign, and an outflow-only read KEEPS the occurrence -- its
                    amount is unknown too, so the consumer's total is withheld,
                    where dropping it would hide a possible payment behind a total
                    that still looked complete.
                    The candidate read may narrow on the stored sign only for
                    shapes nothing can move: it keeps every FX-sensitive schedule
                    AND every schedule carrying an override with an amount or its
                    own splits (an override replaces the amount and the SHAPE, so
                    a +100 schedule overridden to -250, or to a split holding an
                    embedded investment with no amount of its own, is a genuine
                    outflow the snapshot cannot see). The direction is applied
                    after pricing, and the per-schedule cap after that -- capping
                    first let an overridden credit hide the real outflow behind it.
# System Invariants

The conditions that must hold regardless of which controller, service, cron,
importer, provider or form is involved. An invariant here is a claim about the
system as a whole, so it cannot be satisfied by one call site behaving
correctly -- which is the failure mode this catalog exists to prevent. Several
of the entries below were broken by a change that was locally reasonable and
globally wrong, and the reviewer had no document to check it against.

**Status is stated honestly.** An invariant marked `enforced` has a mechanism
named in its entry. One marked `unenforced` describes a condition the system
currently violates, with the violation cited. This catalog is not a description
of the code; it is the target the code is measured against, and the gap is the
useful part. Nothing here is closed by editing this file.

How the statuses are used:

| Status | Meaning |
| --- | --- |
| `enforced` | A named mechanism makes the violation fail. Cite it in reviews. |
| `partial` | Some paths enforce it, others do not. The unenforced paths are listed. |
| `unenforced` | The system can violate this today. |

## Field template

Each entry carries these fields. Where a field says `--`, it is genuinely not
applicable, not merely unknown.

```text
Statement           what must always be true
Source of truth     the row, ledger, provider object or job state that decides
Enforcement         constraint, index, lock, CAS, claim, allowlist, or "none"
Concurrency scope   account, user, holding, occurrence, token, provider key, global
Retry semantics     which retries are safe, and what prevents duplication
Crash semantics     expected state before commit, after commit, mid-finalization
Failure response    409, 404, null, reconcile, refuse, partial
Required tests      per docs/verification-contract.md
Status              enforced | partial | unenforced
```

Two fields a reader might expect are deliberately absent. **CI owner** lives in
`docs/verification-contract.md` section 4 instead, so the job names appear once
rather than in thirty entries that would drift independently of the workflow.
**Subsystem owner** is omitted because this project does not have per-subsystem
owners; adding a column that would read "maintainer" throughout would be
ceremony. Reinstate either the moment it would carry real information.

An entry states only what has been checked. Where a field would require a claim
that was not verified against the source, it says so in the field rather than
guessing. Several entries also name a gold-standard test still owed (a
two-connection race, a two-instance cron) even where the mechanism is enforced:
the mechanism is cited as present, and the missing proof is stated rather than
implied.

## Index

| ID | Invariant | Status |
| --- | --- | --- |
| INV-IMPORT-001 | At most one pending or running MNY import per user | enforced |
| INV-IMPORT-002 | A retry never double-imports | enforced |
| INV-IMPORT-003 | A category collision does not abort an import | unenforced |
| INV-BALANCE-001 | `current_balance` equals opening balance plus included ledger rows | enforced |
| INV-HOLDING-001 | A holding equals a deterministic replay of the investment ledger | enforced |
| INV-HOLDING-002 | Every view replays the ledger the same way | enforced |
| INV-TRANSFER-001 | A transfer's two legs share the VOID boundary and one balance decision | enforced |
| INV-REDEEM-001 | A redemption's accrued interest moves cash once and is income once | enforced |
| INV-RECONCILE-001 | While the strict lock is on, a reconciled transaction is not altered | enforced |
| INV-FX-001 | An unavailable rate never becomes 1:1 | enforced |
| INV-REPORT-001 | A report's account scope is investment linkage, not account type | enforced |
| INV-REPORT-002 | A chart's down-sampling never reaches a count, a total or an export | enforced |
| INV-LOAN-001 | A recurring overpayment's cadence is a calendar, not a payment interval | enforced |
| INV-LOAN-002 | A schedule truncated by the projection horizon yields no lifetime total | enforced |
| INV-LOAN-003 | One named compounding convention, from preview to projection to displayed EAR | enforced |
| INV-LOAN-004 | The final payment is the residual payoff, not another installment | enforced |
| INV-LOAN-005 | The first payment date is payment number 1 | enforced |
| INV-LOAN-006 | A scheduled loan installment prices the ledger debt, and the rate, through its own due date | enforced |
| INV-LOAN-HISTORY-001 | Historical loan interest counted as paid is ledger-backed | partial |
| INV-OCCURRENCE-001 | One scheduled occurrence has at most one financial effect | enforced |
| INV-OCCURRENCE-002 | A stored override price survives reopening | enforced |
| INV-OCCURRENCE-003 | Every surface reports the effective occurrence: its current amount and currency, its direction, on the date it falls | enforced |
| INV-CLAIM-001 | An emergency-access claim token is consumed exactly once | enforced |
| INV-AUTH-001 | A refresh token rotates once, or the family is revoked | enforced |
| INV-AUTH-002 | A failed-login counter records every failure | enforced |
| INV-AUTH-003 | A destructive OIDC action requires a provider round trip | enforced |
| INV-AUTH-004 | A logout reports only what it achieved | enforced |
| INV-ACTIVITY-001 | Activity is attributed to whoever acted, not to whoever was acted for | enforced |
| INV-PROFILE-001 | A user-profile response is an allowlist | enforced |
| INV-DISPLAY-001 | A figure addressed to a person is rendered in that person's number locale | enforced |
| INV-MCP-001 | Identity comes from the credential on the request | enforced |
| INV-MCP-002 | An MCP request is answered by the MCP transport, never by the app shell | enforced |
| INV-MCP-003 | A write confirmation is bound to one credential and one change | enforced |
| INV-MCP-004 | A write happens only on the round a human answered | enforced |
| INV-CURRENCY-001 | A shared currency is deleted only by its creator, on a global count | enforced |
| INV-ATTACHMENT-001 | Available metadata resolves to committed bytes | enforced |
| INV-ATTACHMENT-002 | A scanned document and its original are one attachment | enforced |
| INV-BACKUP-001 | A backup file is complete, verified and owner-namespaced | enforced |
| INV-PUSH-001 | A push subscription belongs to the authenticated caller, and no request touches another account's device | enforced |
| INV-PUSH-002 | The VAPID private key never leaves the server, and is never stored unencrypted | enforced |
| INV-PUSH-006 | A push channel is offered only while its key pair can actually be used | enforced |
| INV-PUSH-003 | A key rotation retires every subscription minted under the superseded pair | enforced |
| INV-PUSH-004 | A push failure never rolls back what produced it, and a dead subscription stops being attempted | enforced |
| INV-PUSH-005 | A push subscription is instance-bound state, never portable backup data | enforced |
| INV-PUSH-007 | UnifiedPush is delivered by the one Web Push sender; no second transport importer exists | enforced |
| INV-PUSH-008 | A subscription's transport gates its delivery: the `push` and `unifiedpush` channels reach only their own wire's devices | enforced |
| INV-PUSH-009 | A channel a category does not expose is forced off at resolution, whatever the stored row says | enforced |
| INV-PUSH-010 | A UnifiedPush endpoint is validated as a server-outbound URL, and its transport is bounded to one list held equal across DTO, schema and client | enforced |
| INV-CRON-001 | One logical cron effect per schedule tick, across replicas | partial |
| INV-PROVIDER-001 | An unreachable provider stops being called, and produces at most one alert pair per outage | enforced |
| INV-ALERT-001 | A system alert row lands at most once per (recipient, dedupe key), and only the insert winner emails | enforced |
| INV-NOTIFY-001 | Every notification a producer creates is written by NotificationService.create; the restore's dynamic-table insert is outside the scan | partial |
| INV-DISPATCH-001 | The dispatch seam never writes a notification row itself; `create` stays the sole writer | enforced |
| INV-DISPATCH-002 | The in-app row is written for every `notify`, whatever the matrix or the throttle says | enforced |
| INV-DISPATCH-003 | The throttle gates only the notification-mode fan-out, never the in-app row or a report, and never an escalation | enforced |
| INV-DISPATCH-004 | A failed push or email never rolls back, or surfaces through, the notification it is about | enforced |
| INV-RLS-001 | Enforced mode refuses to run on a role that can bypass RLS | enforced |
| INV-CACHE-001 | A money-moving write invalidates every derived cache | enforced |
| INV-PAYEE-001 | A contact lookup never overwrites a value the user entered, and the automatic one runs at most once per payee | enforced |
| INV-PAYEE-002 | Google Places requests in one Pacific calendar month never exceed the cap for the key's owner | enforced |
| INV-RELEASE-001 | The tested, imaged and tagged revisions are one revision | partial |
| INV-MIGRATION-001 | Migrations apply in numeric prefix order, and a new migration's prefix cannot collide | enforced |

## Imports

### INV-IMPORT-001 -- at most one pending or running MNY import per user

```text
Statement           For one user, at most one import job may be pending or running.
Source of truth     import_jobs.status
Enforcement         Partial unique index idx_import_jobs_one_active_per_user on
                    import_jobs(user_id) WHERE status IN ('pending','running'),
                    added by database/migrations/135_import_jobs_single_active.sql.
                    The service's hasActiveJob() pre-check is advisory only and
                    is commented as such; isActiveJobConflict() translates
                    SQLSTATE 23505 into the same 409.
Concurrency scope   per user
Retry semantics     A retry after failure is a new job row; safe.
Crash semantics     A crashed worker leaves status='running' with a stale
                    heartbeat; reapStaleJobs fails it retryably after 5 minutes.
Failure response    409 Conflict
Required tests      Two-connection: two concurrent starts, one winner. Present in
                    backend/test/integration/mny-import-job.integration.spec.ts
                    ("has exactly one winner when two starts race over the same
                    staged file", "has one winner across four concurrent starts",
                    "lets two users start imports concurrently").
Status              enforced
```

This is the reference implementation for the whole catalog. The migration's own
comment explains why the constraint rather than the check: the service counted
active jobs and inserted in a second transaction, so two overlapping starts both
saw zero, and because each parse pre-generates fresh transaction UUIDs nothing
downstream deduplicated the second run. With `wipeExistingData` both requests
could also reach the destructive wipe.

### INV-IMPORT-002 -- a retry never double-imports

```text
Statement           Retrying a failed import must not insert a second copy of
                    rows a previous attempt may have committed.
Source of truth     import_jobs.data_committed and import_jobs.attempt_token,
                    written in writeAll's own transaction
Enforcement         A durable commit checkpoint claimed under an attempt fence.
                    import_jobs.data_committed (migration 140) is set by
                    markDataCommitted as the LAST statement of writeAll's
                    transaction (mny-import.service.ts, mny-import-job.service.ts),
                    a fenced compare-and-set WHERE status='running' AND
                    attempt_token=$n -- so a zero-row result throws and rolls the
                    rows back with it. attempt_token (migration 144) gives each
                    claim an identity a reaped-and-reclaimed job cannot forge, and
                    migration 145's reject_unfenced_import_checkpoint trigger
                    refuses a false->true data_committed on a non-running job from
                    either binary during a rolling deploy. fail() ANDs the caller's
                    retryable with data_committed = false, and the reaper marks a
                    committed stalled job non-retryable, so a committed run is
                    finalized rather than replayed.
Concurrency scope   per user, per attempt
Retry semantics     Safe. A failure inside writeAll rolled everything back; a
                    committed run is recognised by data_committed and refused a
                    replay.
Crash semantics     A crash after writeAll commits leaves data_committed=true, so
                    the reaper finalizes rather than re-runs; a crash before it
                    leaves nothing, since the checkpoint is the transaction's last
                    statement.
Failure response    reconcile -- finalize the committed run rather than replay it.
Required tests      Failpoint present: backend/test/integration/mny-import-job.integration.spec.ts
                    commits writeAll then fails before terminal completion, retries,
                    and asserts the checkpoint is refused after a reap, the whole
                    transaction rolls back so nothing is doubled, a legacy
                    previous-release checkpoint is refused, and a retry claims a
                    fresh token while the stale worker is fenced.
Status              enforced
```

This entry was itself marked `enforced` in an earlier revision on the strength of
a source comment ("The whole write is one transaction, so a failure leaves nothing
behind and Retry cannot double-import") that was true of `writeAll` alone and not
of the import, which was not finished when `writeAll` committed. It is now
genuinely enforced, by the mechanism above rather than the comment -- and it
remains the catalog's cautionary tale that a status copied from a comment is not a
verified status. `docs/concurrency-and-idempotency.md` CONC-007 is the rule that a
named mechanism has to cover the scope claimed; the "Deciding a worker is dead"
section of `backend/CLAUDE.md` has the fence in full.

### INV-IMPORT-003 -- a category collision does not abort an import

```text
Statement           A category the import needs, created concurrently by the same
                    user, must not fail the import.
Source of truth     categories
Enforcement         None. import.service.ts does findOne then create/save. A
                    concurrent manual create raises a unique violation that
                    aborts the whole import transaction.
Concurrency scope   per user
Retry semantics     The user must restart the entire import.
Failure response    Currently a 500 losing the whole import; should be adopting
                    the winner's row.
Required tests      Two-connection: manual category create interleaved with an
                    import needing the same category.
Status              unenforced
```

The cost is disproportionate to the cause: an entire `.mny` import is lost
because one category already existed. `INSERT ... ON CONFLICT DO NOTHING
RETURNING id` plus adopting the winner's row is the fix, and per
`docs/financial-calculation-contract.md` section 6 the conflict path must then
re-read rather than reuse the pre-insert snapshot. Note that no unique index
currently covers top-level categories (`parent_id IS NULL`), so closing this
properly needs the index too.

## Ledger and derived values

### INV-BALANCE-001 -- current_balance equals its ledger

```text
Statement           accounts.current_balance equals opening balance plus every
                    included, non-void, non-child ledger transaction up to the
                    applicable date.
Source of truth     transactions, summed; accounts.opening_balance
Enforcement         Every absolute recompute takes the account lock before reading
                    the ledger. lockAccountsForBalanceWrite (common/db/locks.ts,
                    SELECT ... FOR UPDATE, owner-scoped, id-sorted) is taken by
                    recalculateCurrentBalance, the hourly applyDueTransactionBalances,
                    import-post-processing, action-history and net-worth before they
                    recompute, so a delta can no longer commit between a recompute's
                    read and its write. The atomic delta path (updateBalance) is
                    unchanged. A VOID transfer moves neither balance
                    (transaction-transfer.service.ts skips both updateBalance calls).
Concurrency scope   per account
Retry semantics     A recompute is idempotent against another recompute and, under
                    the lock, against a concurrent delta.
Failure response    balances reflect every included non-void non-child row.
Required tests      Source scan: common/db/derived-state-writers.guard.spec.ts --
                    only sanctioned services write current_balance, and each reads
                    under a lock. Two-connection (delta interleaved with a recompute,
                    the delta must survive): backend/test/integration/balance-delta-recompute.integration.spec.ts.
Status              enforced
```

See `docs/concurrency-and-idempotency.md` CONC-003. The former secondary breach --
transfers created as `VOID` moving both balances -- is closed on the create path
too.

### INV-HOLDING-001 -- a holding is a deterministic ledger replay

```text
Statement           holdings.quantity and average_cost equal a deterministic
                    replay of that account's investment ledger.
Source of truth     investment_transactions
Enforcement         Every mutation path takes an account-scoped advisory lock.
                    lockHoldingScope (common/db/locks.ts) is taken by
                    createOrUpdate, updateHolding, applySplit, reverseSplit,
                    adjustQuantity and rebuild -- advisory rather than a row lock
                    because a rebuild must serialize against investment_transactions
                    inserts that no holdings row-lock covers -- so two concurrent
                    trades on one (account, security) cannot lose an update.
                    UNIQUE(account_id, security_id) still prevents duplicate rows.
Concurrency scope   per (account, security)
Retry semantics     Serialized by the lock; a lost update cannot occur.
Failure response    the stored holding equals a deterministic replay of the ledger.
Required tests      Two-connection (concurrent trades on one holding, the stored
                    row compared against the replay):
                    backend/test/integration/holding-concurrent-trades.integration.spec.ts.
Status              enforced
```

### INV-HOLDING-002 -- every view replays the ledger the same way

```text
Statement           Every surface that derives a share count from the investment
                    ledger must apply each action identically.
Source of truth     the shared reducer applyActionToQuantity
Enforcement         One shared reducer, called by every surface.
                    applyActionToQuantity (securities/investment-replay.util.ts)
                    folds each action into the running share count -- multiplying
                    on SPLIT, with SHARE_MOVING_ACTIONS naming the set -- and both
                    holdings.service.ts and net-worth.service.ts (all three of its
                    reducers) call it rather than hand-rolling the fold. The old
                    disagreement (net-worth adding on SPLIT and omitting
                    ADD_SHARES/REMOVE_SHARES) is gone.
Concurrency scope   --
Failure response    The holdings page and the historical net-worth charts report
                    one share count for a position after any split.
Required tests      Source scan: securities/investment-replay.guard.spec.ts fails
                    on any SPLIT branch computing a quantity outside the reducer,
                    a hand-listed disposal set, and a `quantity *=` anywhere.
Status              enforced
```

The arithmetic the reducer centralises: 90 shares at ratio 2.0 is 180, and the
additive form the net-worth reducers once used gave 92. This invariant is separate
from INV-HOLDING-001 on purpose -- that one is about concurrency, this one about
two implementations of the same rule.

### INV-TRANSFER-001 -- both legs, one decision

```text
Statement           A transfer's legs share the VOID boundary, and any balance
                    movement is decided once for the pair. Reconciliation states
                    (PENDING/CLEARED/RECONCILED) are deliberately per-ledger and
                    are not mirrored -- only VOID inclusion is shared.
Source of truth     the two linked transactions rows
Enforcement         The balance decision is made once per pair, keyed on VOID.
                    Creating a VOID transfer moves neither balance
                    (transaction-transfer.service.ts skips both updateBalance
                    calls when status is VOID). A status edit crossing the VOID
                    boundary mirrors the counterpart leg and a split parent's
                    transfer children (applyVoidTransitionToMirrorLeg,
                    applyParentStatusToTransferCounterparts in
                    transaction-reconciliation.service.ts). markCleared / reconcile
                    / unreconcile deliberately do NOT mirror, because a reconcile
                    state is per-ledger. Guards: deletion-balance.guard.spec.ts,
                    investment-void-classification.guard.spec.ts,
                    void-status-transition.util.ts.
Concurrency scope   per transfer pair
Failure response    consistent balances across the pair on every VOID transition.
Required tests      Per status-changing path, both legs' balances stay consistent
                    across a VOID transition, including the split-transfer variant
                    that links through the split parent rather than a mirror leg.
Status              enforced
```

The statement was narrowed on purpose. "Both legs share one status" was too broad:
a reconcile state is genuinely per-ledger (a cross-owner transfer's two ledgers
reconcile independently), and only the VOID boundary -- where money either moved
or did not -- is shared. See `backend/CLAUDE.md`, "Editing one row must not leave
the pair describing two different events".

### INV-REDEEM-001 -- a redemption's accrued interest moves cash once

```text
Statement           A REDEEM carrying accrued interest produces exactly one cash
                    transaction, for proceeds plus interest, and the interest is
                    counted exactly once as interest income.
Source of truth     the REDEEM row and its linked INTEREST companion
Enforcement         disposalCashAmount (securities/accrued-interest.util.ts) is
                    the only place the two are added; the companion is written
                    with transaction_id null, so it can produce no second cash
                    row. accrued-interest.guard.spec.ts fails a hand-rolled
                    addition elsewhere. The companion is created, statused and
                    deleted with the redemption inside one withScopedDb.
Concurrency scope   per redemption pair
Retry semantics     None needed: create, edit and delete each run in one
                    transaction, and the companion has no independent write path.
Crash semantics     Before commit, neither row exists. After commit, both rows
                    and the single cash row exist. There is no mid-state where a
                    companion exists without its redemption.
Failure response    400 before any write for a non-REDEEM action, a negative
                    value, or a row embedded in a split.
Required tests      docs/specs/redemption-accrued-interest.md section 6.
Status              enforced
```

### INV-RECONCILE-001 -- while the strict lock is on, a reconciled transaction is not altered

```text
Statement           While user_preferences.lock_reconciled_transactions is true,
                    no request may change a RECONCILED transaction of that user:
                    not its fields, not its splits, not its existence, and not
                    its status -- unreconciling included, since an escape hatch
                    one click from the row is not a lock. Turning the preference
                    off is the only way through, and that is a deliberate
                    decision about the whole ledger rather than an accident on
                    one row.
Source of truth     transactions.status, read from the row locked by the writing
                    transaction; user_preferences.lock_reconciled_transactions
                    for whether the lock applies.
Enforcement         assertReconciledRowsMutable / assertReconciledIdsMutable
                    (backend/src/transactions/reconciled-lock.util.ts), called
                    inside each mutation's own withScopedDb, after the row lock
                    and before the first write.
                    backend/src/transactions/reconciled-lock.guard.spec.ts
                    enumerates the covered entry points, extracts each method's
                    body and fails when one stops asking -- and separately fails
                    when an assertion sits before its transaction opens.
                    Covered: TransactionsService.update / remove,
                    TransactionReconciliationService.applyStatusTransition (the
                    resolver behind clear / reconcile / unreconcile and
                    PATCH :id/status) and its bulkReconcile,
                    TransactionTransferService.removeTransfer /
                    updateTransfer, TransactionBulkUpdateService.bulkUpdate /
                    bulkDelete, TransactionSplitService.updateSplits / addSplit /
                    removeSplit, ActionHistoryService.undoTransactionUpdate (undo
                    and redo of a transaction edit) and
                    InvestmentTransactionsService.updateEmbeddedSplitParent (the
                    split parent's amount recomputed when an embedded investment
                    row changes). The last two receive an ambient EntityManager
                    rather than opening their own withScopedDb, so the guard scans
                    them with a `beforeWrite` marker -- the assertion must precede
                    the method's first write. The AI assistant, the MCP tools and
                    the joint register reach the ledger through these same methods,
                    so they inherit the refusal rather than needing their own.
                    The backup restore is deliberately exempt: it rewrites the
                      whole ledger under withPreserveTimestamps, and a
                      per-row refusal there would produce a half-restored
                      database, which is worse than the thing the lock prevents.
Concurrency scope   per transaction row, under the same lock as the write
Retry semantics     A refusal is terminal, not retryable: the answer does not
                    change until the user changes the preference. Nothing is
                    written, so a client retry is harmless.
Crash semantics     Not applicable -- the guard writes nothing. A crash before
                    commit rolls back the whole mutation, guard included.
Failure response    409 Conflict, errors.transactions.reconciledLocked
Required tests      Unit: the guard refuses on a reconciled row, allows the same
                    write with the lock off, refuses a mixed set on the strength
                    of one reconciled row, and does not read the preference when
                    no row is reconciled
                    (backend/src/transactions/reconciled-lock.util.spec.ts).
                    Service: a refusal leaves the row and the balance untouched
                    (backend/src/transactions/transaction-reconciliation.service.spec.ts,
                    "the strict reconciled lock"). Source scan: every listed
                    entry point still asks, inside its transaction
                    (backend/src/transactions/reconciled-lock.guard.spec.ts),
                    now including the undo/redo and embedded-investment paths.
                    Still owed: a two-connection test that the refusal holds
                    against a concurrent write.
Status              enforced
```

### INV-FX-001 -- an unavailable rate is not 1:1

```text
Statement           A cross-currency value must never become a valid-looking 1:1
                    value, and an unconverted amount must never be returned under
                    the target currency's label.
Source of truth     exchange_rates
Enforcement         Consumers return null on an absent rate, and accumulate
                    through FxAggregate. net-worth.service.ts convertCurrency
                    returns number | null (the `result ?? amount` fallback is
                    gone); portfolio-calculation.service.ts returns null when
                    neither direct nor reverse rate exists (the `: 1` else-branch
                    is gone). A scanning guard, common/fx-fallback.guard.spec.ts,
                    bans `?? amount` beside a conversion, `rate ... : 1` / `?? 1`,
                    and an unreviewed `1 / reverse` reciprocal, and asserts each
                    reviewed reciprocal returns null when neither direction exists.
Concurrency scope   --
Failure response    null or an explicitly partial figure, per
                    docs/financial-calculation-contract.md section 1.
Required tests      Present: common/fx-fallback.guard.spec.ts (the source scan
                    above) plus the FxAggregate accumulator (common/fx-aggregate.ts)
                    that names each unresolvable pair rather than absorbing it.
Status              enforced
```

At a real rate of 1.3500, a false 100.00 CAD would understate a 135.00 CAD
position by 35.00 and report it as measured -- which is what the null return and
the scan now prevent.

### INV-REPORT-001 -- a report's account scope is investment linkage, not account type

```text
Statement           A report over the transaction ledger includes an ordinary
                    categorized cash row whatever account it sits in, and
                    excludes a row that is an investment movement. Membership is
                    decided by what the row IS -- the cash leg of an investment
                    transaction, or a row in a securities sleeve -- never by the
                    account's type. An INVESTMENT account is a pair, and its
                    INVESTMENT_CASH sleeve is ordinary money: salary, interest,
                    fees, transfers in and out; a standalone INVESTMENT account
                    (account_type INVESTMENT with a NULL sub-type, which the
                    ordinary account-create path produces and which net_worth and
                    the monthly comparison already branch on) IS its own cash
                    side.
                    The claim is symmetric, and the account type fails in both
                    directions: an investment action with an explicit
                    fundingAccountId posts its generated cash into an ORDINARY
                    account, where an account-type predicate cannot see it at
                    all.
Source of truth     investment_transactions.transaction_id /
                    .transaction_split_id for the linkage; accounts.
                    account_sub_type for the sleeve. Not accounts.account_type,
                    which is the same value for both halves of the pair.
Enforcement         One predicate, in backend/src/common/investment-filter.util.ts:
                    investmentExclusionSql for raw-SQL report queries,
                    applyInvestmentTransactionFilters for QueryBuilder callers,
                    both built from the same fragments so the two dialects
                    cannot drift. An embedded investment split is excluded by
                    both of its representations -- the split's declared kind and
                    an investment_transactions row pointing at that split -- and
                    at SPLIT-ROW granularity, so an ordinary sibling line on the
                    same split parent survives (excluding the parent would lose
                    it; keying only on transaction_id would miss the embedded
                    line entirely, since its transaction_id is null).
                    A report that reads only the parent row cannot classify a
                    line at all -- t.amount there is the sum of every child --
                    so it derives its figure through
                    reportableTransactionAmountSql: the sum of the children that
                    are neither transfer nor investment, NULL when the row
                    represents no ordinary cash. Spending by Payee, Recurring
                    Expenses, Bill Payment History and the Uncategorized list
                    and summary read that instead of t.amount. Duplicate
                    Transactions is the one declared exception, marked in its SQL
                    as a PARENT-IDENTITY REPORT: its subject is the stored row,
                    so a split parent entered twice is a duplicate at its stored
                    amount and the remedy is deleting one whole transaction.
                    Applied by all fifteen ledger queries under
                    backend/src/built-in-reports/ and by the "Uncategorized"
                    filters on the register (transactions.service.ts), the
                    register summary (transaction-analytics.service.ts) and the
                    bulk-update filter (transaction-bulk-update.service.ts) --
                    the last one a write path, where the old predicate let a
                    "select all uncategorized" sweep reach the cash legs a trade
                    owns. Two scans in
                    backend/src/common/investment-filter.guard.spec.ts: no
                    account-type exclusion anywhere in src/, and every
                    built-in-report query that is not transfer-only carries the
                    exclusion IN THE REPRESENTATION ITS SHAPE NEEDS -- a query
                    joining transaction_splits must use the split-aware
                    conjunction, and a parent-only query must derive its amount,
                    since accepting the bare substring passed exactly the defect
                    the branch audit found (F-RPT-001). Both exemptions are
                    derived from the query rather than kept as a list of file
                    names: transfer-only (an investment cash leg is never a
                    transfer) and the declared PARENT-IDENTITY marker. The
                    classifier carries its own negative controls, so the scan is
                    known to fire rather than merely known to pass.
Concurrency scope   -- (read path)
Retry semantics     -- (read path)
Crash semantics     -- (read path)
Failure response    -- a report answers; it does not refuse.
Required tests      Present: the two source scans above, and
                    backend/test/integration/report-investment-cash.integration
                    .spec.ts, which reproduces issue #1257 against a real
                    database using the real writer
                    (InvestmentTransactionsService.create posts the cash leg)
                    and asserts both directions -- $1,000 of sleeve income
                    reaching Cash Flow and Income by Source, the generated leg
                    staying out of spending, payees, Uncategorized and
                    duplicates, the parent-only consumers reporting a mixed
                    split at its ordinary 60 rather than the parent's 560 or
                    nothing at all (by payee, as recurring spending, and in the
                    Uncategorized list and summary), a pure embedded-investment
                    passthrough being absent from Uncategorized and never
                    learned as a recurring expense, the custom report engine
                    answering the same 60 through five groupings and agreeing
                    with the built-in report over one fixture, a brokerage-sleeve
                    row
                    staying out, generated
                    cash staying out of an ORDINARY funding account's report
                    (BUY debit and DIVIDEND credit), a SELL credit staying out
                    of income, ordinary cash on a standalone INVESTMENT account
                    counting, the VOID and transfer-split exclusions still
                    holding, an embedded investment split not becoming an
                    Uncategorized bucket while its ordinary sibling still
                    counts, the three Cash Flow queries reconciling with each
                    other, and the catalogue-wide claim that adding a trade
                    changes no report's answer. Unit specs mock manager.query and can only
                    assert the text of the SQL, which is why the behavioural
                    proof is the integration suite.
Also covered        backend/src/reports/ -- the USER-DEFINED custom report
                    engine. It reads the same ledger through hydrated TypeORM
                    entities and aggregates in TypeScript, so no SQL fragment
                    reaches it; it gets the same rule in the other dialect
                    (isEmbeddedInvestmentSplit / ordinarySplitLines /
                    reportableTransactionAmount, beside the SQL in
                    investment-filter.util.ts). Its selector always excludes the
                    generated cash leg (investmentLinkedTransactionExclusion) and
                    excludes the securities sleeve
                    (brokerageExclusionForEntity) only from a report that did not
                    NAME an account -- built-in reports have no account picker,
                    this one does, and answering an explicitly scoped report with
                    nothing is worse than showing the rows that were asked for.
                    It hydrates splits.investmentTransaction; its six aggregators
                    iterate
                    ordinary lines and ask for the reportable amount rather than
                    reading a parent's own. Until this was done a generated BUY
                    leg was reported as `Uncategorized` spending and the
                    canonical -560 parent reported 560 rather than 60 (re-audit
                    F-CUSTOM-001) -- existing debt rather than a regression: that
                    engine is byte-identical at the merge base. The two dialects
                    differ by exactly one clause, deliberately: the SQL form
                    drops transfer children because no built-in report using it
                    includes transfers, while this one says nothing about
                    transfers at all. Direction (Income/Expenses only) is
                    applied to the split LINES in that engine, never to the
                    parent's own amount: a -60 expense beside a +500 embedded
                    SELL is a +440 parent, and rejecting that row on its sum
                    discarded the expense before provenance could run (audit
                    F-CUSTOM-DIR-001). The securities-sleeve exception is per
                    ROW, keyed on the accounts the report explicitly names,
                    because conditions inside a filter group are OR'd and a
                    whole-report boolean cannot tell `account = Brokerage OR
                    category = Salary` from `account = Chequing OR payee = Acme`
                    (F-CUSTOM-OR-001).
                    Transfer SPLIT LINES are the report's own decision, not this
                    invariant's: `includeTransfers` is applied per LINE in that
                    engine (`narrowSplitLines`), because a split parent carrying
                    a transfer line is not itself a transfer -- so a -260 parent
                    of -60 groceries and a -200 transfer reported 260 until it
                    was. Investment provenance is a property of the data; which
                    transfers to count is a property of the report.
                    The AI forecast baseline
                    (ai/forecast/forecast-aggregator.service.ts) reads one row
                    per payment with no split join, so it derives the reportable
                    amount too: it had been training on a -560 parent as 560 of
                    household spending.
                    The category-keyed aggregates (ai/insights,
                    budgets/budget-generator, the payee totals) are structurally
                    unable to admit either row and are deliberately not listed as
                    mechanism: each INNER JOINs a category, and a generated cash
                    leg has none while a split parent's own category_id is NULL.
                    If one of those joins is ever loosened to a LEFT JOIN it
                    needs this predicate in the same change.
Status              enforced
```

The defect this records was not a subtle one: with `AND a.account_type !=
'INVESTMENT'` in place, sixteen of the twenty-three integration cases above
fail, and the rest pass only because every report was uniformly empty for that
account. The focused audit of issue #1257 recorded the same root as
`F-1257-001` (MEDIUM, derived reporting only -- no stored balance is wrong) and
the naive-repair trap as `DR-1257-001`.

The parent-only half was found by a second audit, of the fix itself
(`F-RPT-001`), and is worth recording as its own lesson: removing a filter that
was hiding too much exposes every row it was also hiding *correctly*. The
account-type predicate had been doing two jobs, and only one of them was wrong.
Five of the cases above fail on the first fix and pass on the second.

### INV-REPORT-002 -- a chart reduction never reaches a figure

```text
Statement           Reducing a series so it fits a chart axis is a RENDERING
                    decision and reaches nothing else. No count, total, average,
                    percentage, summary card or export may be derived from a
                    down-sampled or lossily bucketed series; each is derived from
                    the full data the reduction was made from. Two reductions,
                    because a series is one of two kinds: a STOCK (a balance, a
                    running total) has a value at a point in time, so showing
                    every Nth point drops resolution while every point still
                    drawn means what it meant; a FLOW (what a period paid) only
                    means anything over an interval, so dropping a point deletes
                    the interval it stood for and the chart shows a subset
                    presented as the whole. A flow is reduced by SUMMING
                    contiguous groups.
                    What the ban names is a reduction that CHANGES a figure's
                    meaning or provenance, not the word "aggregate": a rollup
                    that preserves both is not one. The Debt Payoff Timeline's
                    summary reads the full monthly series precisely because a
                    month's end-of-month balance and cumulative totals are the
                    same facts the events carry, exactly. A count is the case
                    that is never preserved -- a month is not a payment. Weekly
                    and biweekly schedules, extra principal payments and two
                    payments in one month all collapse into one bucket, so a
                    count taken after aggregation is wrong before any sampling
                    happens.
                    Provenance is the other thing an aggregation must preserve,
                    and it survives only by being part of the group's IDENTITY.
                    Which side of the history/projection line a row is on is
                    grouped ON, never computed from the group's members
                    afterwards: a weekly, biweekly or semi-monthly loan routinely
                    has a real payment and a projected one in the same calendar
                    month, so a month keyed on its label alone is a bucket that
                    is neither measured nor predicted. One bar cannot honestly be
                    half measured and half predicted, and neither can the row a
                    bar is built from.
                    A label is therefore not an identity. Two chart rows share
                    one -- the month either side of the line, and a bucketed flow
                    row labelled as the span it covers -- while recharts keys its
                    category axis, its tooltip lookup and every ReferenceLine on
                    the datum's own value, so two rows under one label collapse
                    onto one category and a marker drawn there lands on whichever
                    came first.
Source of truth     The unreduced series -- for a loan, the payment events
                    frontend/src/lib/loan-history.ts derives from the ledger.
Enforcement         One module: frontend/src/lib/chart-sampling.ts
                    (sampleStockSeries for a stock, bucketFlowSeries for a flow,
                    CHART_MAX_POINTS the shared budget, axisKeyFor/axisTickLabel
                    the row identity a category axis is keyed on). The reduced
                    series is bound to its OWN name and handed to a chart; the
                    full series keeps the name every figure reads. The payment
                    count is historicalPaymentCount (loan-history.ts), read by
                    both the Debt Payoff Timeline and the Loan Amortization
                    report so one loan cannot have two answers.
                    Monthly aggregation in DebtPayoffTimelineReport groups
                    contiguous runs over a DATE-ORDERED series keyed on the month
                    AND the row's side of the line, so the group's provenance is
                    its key rather than a property derived from its members, and
                    a future-dated posted payment landing among the projected rows
                    opens its own run instead of being folded back into a month
                    it no longer sits beside. Each resulting row carries an
                    axisKey (its position, then its label) and the charts pass
                    axisTickLabel as their tickFormatter, so the two rows of a
                    shared month are two categories and the tick still reads the
                    month. Whether a projection EXISTS is read from the
                    projection's own rows, never from whether aggregation left an
                    all-projected row: a loan paying off inside the month of its
                    last real payment has a projection whose every row shares that
                    month, and asking the aggregate erased the "Today" divider and
                    the Est. Payoff card together with the forecast principal.
                    frontend/src/lib/chart-reduction.guard.test.ts holds four
                    scans: no count taken by filtering a schedule on isProjected
                    anywhere in src/, no group's provenance derived from its
                    members (`.every(... isProjected ...)`, the exact shape that
                    called a mixed month historical -- `.some` and `.filter` are
                    left alone, being ordinary questions about rows nothing has
                    merged), both loan reports reading the shared count, and no
                    reduced series measured (.length, .reduce, .filter, .some,
                    .every, .forEach, .flatMap) -- a lookup such as .find, which a
                    tooltip needs, is allowed because it cannot aggregate. A fifth
                    pins the Debt Payoff Timeline's three category axes to
                    dataKey="axisKey" and axisTickLabel, since keying one back on
                    the month is how two rows collapse into one. The
                    measurement scan reads one file at a time, so it can only
                    see what a reduced series is CALLED: any name a
                    reduced binding is ALIASED to in the same file
                    (`return { points: chartPoints }`) is banned under the same
                    rule, and a reduced series crossing a module boundary keeps
                    its name so the consuming file is scanned for the name it
                    uses. The binding scan is pinned to an exact list, so a
                    rename cannot silently make the measurement scan scan
                    nothing, and both the alias rule and the measurement scan
                    carry planted-violation controls.
                    A marker drawn ON a reduced series is keyed to that series,
                    not to the full one: a recharts ReferenceLine whose value
                    matches no axis category is silently not drawn, so the
                    Payment Distribution chart's "Today" divider comes from the
                    first projected BUCKET's own axis key -- the balance chart's
                    key addresses a row of a different series, and a bare month
                    matches no bucketed range.
Concurrency scope   -- (render path)
Retry semantics     -- (render path)
Crash semantics     -- (render path)
Failure response    -- a chart draws; it does not refuse.
Required tests      Present: the source scans above; the unit matrix in
                    frontend/src/lib/chart-sampling.test.ts (a stock sample keeps
                    the endpoints and every kept row and emits each index once; a
                    flow bucket conserves the total, stays within the budget,
                    hands each bucket its own position and never merges across a
                    boundary -- split 101/99 rather than 100/100, so the
                    transition falls INSIDE a group and the flush is what saves
                    it, since an even split passes with the boundary mechanism
                    deleted; and an axis key is unique per row, prints its label
                    back including a label holding the separator, and passes a
                    non-key value through); and the behavioural cases in
                    frontend/src/components/reports/DebtPayoffTimelineReport
                    .test.tsx, which assert Payments Made against a 300-payment
                    history while the chart is sampled, two payments in one month
                    counted as two, 26 biweekly payments counted as 26 rather
                    than 12, the distribution chart conserving every month's
                    principal, the distribution chart's "Today" marker naming a
                    key its own axis has, and the history/projection transition
                    surviving the stride. Each fails on the pre-fix component
                    with the figures issue #1244 reports (61, 1, 12, half the
                    money, a marker on a month no bucket is called).
                    Four more hold the provenance rule, on a 0% weekly loan whose
                    one real payment (100 on 3 Aug) and two projected payments
                    (100 each, 17 and 24 Aug) all fall in August, with the clock
                    pinned to 2026-08-10: August's historical principal is 100 and
                    its projected principal 200 rather than 300 of history; the
                    historical balance is the measured 200 rather than the
                    projection's end-of-month 0; the report still knows it has a
                    projection when the loan pays off inside that month, so the
                    Est. Payoff card and the "Today" divider are both drawn and
                    the two August rows are two axis keys under one label; and a
                    future-dated posted payment interleaved with the projected
                    rows stays in its own run, leaving the chart date-ordered with
                    October carrying both a historical and a projected row. All
                    four fail on the merged #1280 component.
                    Each case waits on the COUNT rather than on the chart
                    mounting: a loan carrying terms projects from its current
                    balance alone, so the chart appears on a projection-only
                    schedule one render before the transactions are adopted, and
                    a test barrier that resolves there measures the wrong render.
                    The recharts test mock serializes each chart's `data` and
                    each ReferenceLine's `x`, since a mock that discards either
                    cannot tell a sampled series from a full one, nor see a
                    marker vanish.
Status              enforced
```

The reduction was written for the balance curve, where it is correct, and then
inherited by the count, the totals and the Payment Distribution chart because
all four read one array. That is the shape to look for: a variable that is
assigned its own reduced form (`points = points.filter(...)`) leaves nothing
downstream able to tell which of the two it holds.

The first fix stopped the reduction reaching a figure and left the step BEFORE
it -- monthly aggregation -- grouping on the label alone, so the boundary-aware
reducer that #1244 added was handed rows whose provenance had already been
merged away (PR #1280 audit, F-1280-01). That is the second shape to look for:
a property recomputed from a group's members (`group.every(...)`) is a property
that was not part of what made the group, and the answer is only as good as the
grouping. Make it part of the key, and a mixed bucket becomes unrepresentable
rather than mislabelled.

### INV-LOAN-001 -- a recurring overpayment's cadence is a calendar

```text
Statement           A recurring overpayment declared MONTHLY contributes exactly
                    12 occurrences per calendar year (QUARTERLY 4, ANNUALLY 1)
                    whatever the loan's own payment frequency is, and WEEKLY /
                    BIWEEKLY contribute one every 7 / 14 days. The borrower's
                    nominal annual cash may not change because the loan happens
                    to be paid biweekly.
Source of truth     The overpayment's frequency plus its window, on the plan.
Enforcement         recurringOccurrencesDue (frontend/src/lib/loan-schedule.ts)
                    is the single place a cadence becomes schedule rows: dated
                    occurrences, each applied at the first loan payment on or
                    after its due date. The interval it replaced,
                    round(periodsPerYear / overpaymentsPerYear), rounded 26/12 to
                    2 and paid a monthly extra 13 times a year on a biweekly
                    loan -- 8.3% more cash than the plan describes, with the
                    interest saving overstated to match.
Concurrency scope   --
Retry semantics     --
Crash semantics     -- (projection only; nothing is persisted)
Failure response    --
                    The cadence steps the recurrence engine, the same calendar
                    the loan's payment rows step. Deriving each occurrence from
                    the anchor by index instead kept a 31st anchor on month-end
                    (31 Jan, 28 Feb, 31 Mar, 30 Apr) while the rows accumulated
                    the engine's clamp (31 Jan, 28 Feb, 28 Mar, 28 Apr), so on a
                    monthly loan first paid on the 31st the occurrence due 31
                    March arrived after the 28 March row, waited for 28 April,
                    and the year paid ELEVEN -- this invariant broken by two
                    calendars disagreeing rather than by arithmetic. (Earlier
                    still, `advanceDate` OVERFLOWED -- 31 January to 3 March --
                    which lost February outright.) The price is that an
                    accumulating clamp is lossy: an anchor on the 31st settles
                    onto the 28th after its first February instead of returning
                    to month-end. On a loan whose own payments have settled there
                    that is not a cost, and for any anchor on the 28th or earlier
                    the two are identical. Twelve to a calendar year from every
                    anchor day is the invariant and holds either way; the
                    alignment does not.
                    A plan names its mode in three places
                    (targetMonthlyPaymentMode, recurringExtra.mode, and each
                    lump sum's), so consumers read effectiveOverpaymentMode(plan)
                    rather than one carrier: reading recurringExtraMode alone
                    left a saved BUDGET scenario with no mode and fell back to
                    the installmentReduction heuristic, which is null exactly
                    when a schedule truncated -- the case the explicit mode
                    exists for. Precedence follows the engine: a budget ignores
                    the other two, and otherwise any LOWER_INSTALLMENT carrier
                    makes the plan one, because the engine re-levels when any
                    does and adding the overpayment on top of a re-levelled
                    installment counts the same money twice.
                    ONE_OFF is excluded from RecurringExtra.frequency by TYPE
                    (RecurringOverpaymentFrequency), not by convention: it is a
                    single dated payment and belongs in lumpSums, and accepted as
                    a cadence it collapsed into the legacy per-payment branch.
Required tests      Present: the recurringOccurrencesDue block and the
                    "recurring overpayment cadence in a schedule" block in
                    frontend/src/lib/loan-schedule.test.ts assert the per-year
                    counts across weekly, biweekly and monthly loans and across
                    every anchor day a month can start on, the cumulative "every
                    occurrence paid exactly once" invariant, the month-end clamp,
                    the backwards-rowDate refusal, and the window rules. The
                    goal-seek replay cases in loan-overpayment-solver.test.ts
                    assert a solved amount still reaches its target when replayed
                    through the same cadence.
Status              enforced
```

`perPaymentExtraAmount` survives as a display average for the "resulting monthly
payment" card. It is not what the engine applies, and a balance must never be
computed from it.

### INV-LOAN-002 -- a truncated schedule yields no lifetime total

```text
Statement           A projection that stopped at its horizon rather than paying
                    off has accumulated the horizon's interest, not the loan's.
                    No lifetime figure, and no saving derived from one, may be
                    presented from it.
Source of truth     LoanScheduleResult.paidOff.
Enforcement         The horizon itself is derived from the frequency
                    (maxPaymentsForHorizon: DEFAULT_MAX_PROJECTION_YEARS of this
                    frequency's payments), so an ordinary 25- or 30-year weekly
                    or biweekly mortgage completes -- a flat 600-payment default
                    cut those short, omitting 44% of a 30-year weekly
                    mortgage's lifetime interest and reporting no payoff date. Where truncation is still possible,
                    consumers gate on paidOff. compareSchedules returns null for
                    ALL FOUR of interestSaved, paymentsSaved, monthsSaved and
                    installmentReduction (a horizon's row count, a missing payoff
                    date read as 0 months, and an installment taken from a
                    mid-schedule row are the same defect as the interest);
                    PastImpactResult.interestAlreadySaved and monthsAlreadySaved
                    are null; deriveLoanFigures withholds the payoff date and
                    remaining interest; ScenarioComparisonChart draws only
                    outcomes passing hasKnownInterestSaved and the panel names
                    what it left out; the goal-seek solver returns
                    baseline-incomplete rather than a saving against a subtotal
                    (meetsInterestTarget requires paidOff); and both loan reports
                    (DebtPayoffTimelineReport, LoanAmortizationReport) withhold
                    the projected payoff date and relabel the interest figure
                    "Interest Over Projection" instead of "Est. Total Interest".
Concurrency scope   --
Retry semantics     --
Crash semantics     -- (projection only)
Failure response    null, plus an explicit unknown in the UI -- never 0.00.
Required tests      Present: "projection horizon" and "a truncated schedule is
                    not a lifetime total" in loan-schedule.test.ts (the four
                    ordinary long terms, and every saving null when either side
                    truncates); "a target cannot be met by a truncated schedule"
                    in loan-overpayment-solver.test.ts; the two unknown-saving
                    cases in loan-past-impact.test.ts; the Unknown-card and
                    em-dash cases in ComparisonSummaryCards.test.tsx,
                    PastImpactSection.test.tsx and loan-scenario-labels.test.ts;
                    the two chart-exclusion messages in
                    SavedScenariosPanel.test.tsx.
Missing             A source scan asserting no NEW consumer presents a lifetime
                    figure without the gate. The list above is prose, which the
                    repository's own ranking puts last -- the reports were found
                    ungated by review, not by a test.
Status              enforced
```

### INV-LOAN-003 -- one compounding convention, named

```text
Statement           The mortgage creation preview, the persisted paymentAmount,
                    the scheduled principal/interest split, the frontend
                    projection and the displayed effective annual rate all use
                    one explicitly chosen compounding convention.
Source of truth     docs/financial-semantics.md section 9.
Enforcement         The convention is the nominal annual rate divided by the
                    payments per year (calculateStandardPeriodicRate), with
                    Canadian fixed-rate semi-annual compounding as the one legal
                    exception (calculateCanadianPeriodicRate); the frontend
                    getPeriodicRate mirrors it. calculateEffectiveAnnualRate now
                    takes periodsPerYear and compounds at the payment frequency,
                    so the displayed EAR describes the rate the schedule charges
                    rather than a monthly one nothing used.
                    A cadence read back out of accounts.payment_frequency is a
                    STRING -- the column is a bare VARCHAR(20) written in both
                    spellings -- so it goes through
                    periodsPerYearForStoredFrequency, which answers null rather
                    than guessing, or through toMortgagePaymentFrequency where a
                    mortgage-domain value is genuinely needed. Six call sites
                    cast it to MortgagePaymentFrequency and asked
                    getMortgagePeriodsPerYear instead, whose default of 12 turned
                    SEMIMONTHLY into a monthly rate: the per-posting P/I split,
                    the rate-change recalculation and its scheduled-transaction
                    sync, the inference warning and the account service's own
                    split all booked twice the correct interest on a semi-monthly
                    mortgage, three times on a quarterly one.
                    mortgage-frequency-cast.guard.spec.ts scans src/ for a
                    revived cast, because fixing five of six is what happened
                    the first time.
                    The frequency a periodic rate is divided by must itself be
                    real: SetupLoanPaymentsDto accepts SEMIMONTHLY and the
                    service casts it into calculatePaymentSplit, where
                    getPeriodsPerYear had no such case and fell through to its
                    default of 12 -- a semi-monthly loan's interest split was
                    computed at twice the correct rate. The case exists now, and
                    loan-payment-frequency.guard.spec.ts reads the DTO's @IsIn
                    list out of the source and fails on any accepted value
                    without its own period count or that does not move
                    calculateEndDate, because a cast cannot be type-checked. The
                    frontend has the same hazard and the same scan: the setup
                    dialog stores SEMIMONTHLY, ScheduleFrequency spelled only
                    SEMI_MONTHLY, and every projection surface read 12 periods a
                    year instead of 24. Both spellings are accepted on both
                    layers now. The frequency tables are Records over their
                    unions, so a future widening is a compile error rather than a
                    silent monthly fallback, and toMortgagePaymentFrequency
                    refuses a cadence the mortgage helpers cannot express
                    (QUARTERLY, YEARLY) instead of casting it into their monthly
                    default. PAYMENT_FREQUENCIES is one list per layer with the
                    type derived from it, because AccountForm's optionalEnum maps
                    an unlisted value to undefined -- a form list missing a stored
                    frequency erases it on the first edit. The tables live in
                    payment-frequency.util.ts rather than in the two amortization
                    utils, which had to import each other to share them: under a
                    mortgage-first load order the merged table initialised with
                    only the loan keys, so an accelerated-biweekly mortgage's
                    scheduled transaction was created monthly. The guard requires
                    the modules in the hostile order in a fresh registry, because
                    a completeness assertion cannot see a load-order defect.
Concurrency scope   --
Failure response    --
Required tests      Present: the "periodic-rate convention" block in
                    backend/src/accounts/mortgage-amortization.util.spec.ts and
                    "is the nominal convention, not monthly compounding
                    converted" in frontend/src/lib/loan-schedule.test.ts. Both
                    spell out the REJECTED contract and assert the implementation
                    differs from it -- backend/frontend parity mirrors one
                    formula, so it can only detect drift, never validate the
                    choice. Plus the two frequency scans --
                    loan-payment-frequency.guard.spec.ts reads the DTO's @IsIn
                    list and checks both getPeriodsPerYear and calculateEndDate,
                    loan-frequency.guard.test.ts reads the setup dialog's options
                    and checks the frontend engine -- and the effectiveAnnualRate
                    block in loan-schedule.test.ts.
Status              enforced
```

### INV-LOAN-004 -- the final payment is the residual payoff

```text
Statement           Lifetime interest reflects cash actually paid. The payment
                    that clears the balance is the remaining balance plus that
                    period's interest, not another full installment.
Source of truth     The period-by-period amortization of the same schedule.
Enforcement         calculateResidualPayoff
                    (backend/src/accounts/mortgage-amortization.util.ts) computes
                    the balance after n-1 installments and closes it out, and
                    calculateMortgageAmortization derives totalInterest and
                    residualPayoffAmount from it (deliberately NOT named
                    finalPaymentAmount, which LoanScheduleResult already uses for
                    the ending regular installment). paymentAmount * totalPayments -
                    principal overstated a 25-year accelerated-biweekly
                    mortgage's lifetime interest by 569, because Math.ceil had
                    rounded a fractional payoff count up. The frontend schedule
                    already capped its final principal at the balance, so the two
                    surfaces disagreed.
                    `totalPayments` is a ceiling, not a promise: an installment
                    that clears the balance sooner makes the caller's count too
                    high, so calculateResidualPayoff derives the effective count
                    (paymentsToClear) and returns it, and the result's
                    totalPayments and endDate come from that one number. An
                    installment that never covers the interest yields -1 for all
                    three rather than a precise, enormous total.
                    paymentsToClear itself lives once, in
                    amortization-count.util.ts: the same formula had three copies
                    and two of them ran on identical inputs in a single call.
Concurrency scope   --
Failure response    -1 for all three figures when the schedule is unknowable: a
                    non-finite count, or an installment that never amortizes.
Required tests      Present: "final payment and lifetime interest" in
                    mortgage-amortization.util.spec.ts, whose expectations come
                    from an independent period-by-period simulation in the spec
                    rather than from the implementation, including both
                    directions of the count (an installment clearing early, and
                    a rounding remainder absorbed by the last payment) and the
                    non-amortizing case at a finite count.
Status              enforced
```

### INV-LOAN-005 -- the first payment date is payment number 1

```text
Statement           accounts.payment_start_date is the date of the first payment,
                    so a schedule of N payments advances N-1 intervals to reach
                    its last one.
Source of truth     accounts.payment_start_date.
Enforcement         calculateEndDate (loan-amortization.util.ts) and
                    calculateMortgageEndDate (mortgage-amortization.util.ts)
                    advance totalPayments - 1, with the zero-, negative- and
                    infinite-payment sentinels kept explicit. Advancing N dated
                    every displayed payoff -- and the linked scheduled
                    transaction's endDate, derived from the same value -- one
                    full payment period late.
                    The stepping itself is calculateNextDueDate, the recurrence
                    engine that posts those payments, through advancePaymentDates:
                    this date bounds the scheduled transaction, so it must be a
                    date the scheduler reaches. A hand-rolled semi-monthly step
                    (1st, 15th) against the engine's (15th, last day of month)
                    dated payment 24 of 24 before the final installment, and the
                    schedule posted 23.
                    A Date carrying a calendar date is UTC-midnight throughout
                    these helpers -- the convention ensureYMD and formatDateYMD
                    already share. Reading local components in between put every
                    payoff date a day early outside UTC, and CI's TZ=UTC cannot
                    see it (nor can a Jest worker: setting process.env.TZ does
                    not move Date there).
Concurrency scope   --
Failure response    The start date itself for a zero- or one-payment schedule.
Data already written
                    Migration 166 steps the affected scheduled_transactions.endDate
                    back one interval, scoped to the schedule a LOAN or MORTGAGE
                    account NAMES as its payment schedule
                    (accounts.scheduled_transaction_id, written by exactly the
                    two paths that write this end_date), still active, its bound
                    still in the future, and a whole number of the schedule's own
                    intervals from its start date. Matching "a transfer split
                    points at a debt account" instead would have caught a user's
                    own extra-principal transfer: "monthly, for ten years" is a
                    whole number of intervals too, and this body is not
                    re-runnable. It is a one-shot (registered in
                    NON_RERUNNABLE_DATA_MIGRATIONS), run once per database by
                    schema_migrations.
                    Two populations are deliberately NOT healed, because the old
                    value is not invertible in SQL rather than because it is
                    right: a month cadence anchored on the 29th to 31st (the old
                    stepper overflowed -- 31 January to 3 March -- and carried
                    the new day forward), and SEMIMONTHLY (the old mortgage
                    stepper used the 1st and the 15th where the engine uses the
                    15th and the last day of the month, so the stored bound sits
                    on a different calendar). Re-running payment setup on those
                    accounts rewrites the bound correctly.
Required tests      Present: the calculateEndDate and calculateMortgageEndDate
                    blocks in both specs assert exact calendar dates (12 monthly
                    payments from 2026-01-01 end on 2026-12-01), including the
                    one-payment and zero-payment cases;
                    payment-frequency.timezone.spec.ts walks the offsets in child
                    processes and scans the three helpers for a local accessor.
Status              enforced
```
### INV-LOAN-006 -- a scheduled loan installment prices the ledger debt, and the rate, through its own due date

```text
Statement           The interest of a scheduled loan installment is
                    roundMoney(debt x periodic rate), where BOTH inputs are
                    measured at that installment's due date: debt is the opening
                    balance plus every non-void, top-level transaction dated on
                    or before it, and the rate is the latest loan_rate_changes
                    row effective on or before it (else the account's scalar).
                    Never a value advanced from the previously stored
                    (4dp-rounded) split; never accounts.current_balance, a
                    through-today read model that excludes future-dated rows;
                    and never accounts.interest_rate alone, which a recorded
                    rate change deliberately does not write. The next
                    scheduled bill, the amounts an occurrence actually posts,
                    and the amortization report's first projected row all price
                    that one balance (issue #1253).
Source of truth     The transactions ledger plus accounts.opening_balance
                    (INV-BALANCE-001's source) for the debt, and
                    loan_rate_changes for the rate, both bounded by the
                    installment's own date.
Enforcement         ScheduledTransactionLoanService.resolveInstallment is the
                    one pricing path: datedLoanDebt runs the canonical as-of
                    ledger sum, the periodic-rate rules (Canadian semi-annual
                    compounding included) are unchanged, and allocateLoanPayment
                    stays the shared waterfall. recalculateLoanPaymentSplits
                    (template advancement after a posting) and
                    resolvePostingAllocation (called by the posting path inside
                    its transaction, under the parent lock, immediately before
                    the financial write) both resolve through it -- the stored
                    split is a template/read model, so a principal movement
                    committed between occurrences reaches the amounts actually
                    posted without any mutation path having to invalidate it.
                    The amortization report anchors its projection on
                    GET /scheduled-transactions/loan-anchor/:accountId (the same
                    due-date-bounded debt) through buildLoanProjectionInput's
                    anchor parameter, and
                    frontend/src/lib/loan-projection-anchor.guard.test.ts
                    enumerates every projection call site so a surface either
                    passes the anchor or is listed as deliberately
                    today-anchored -- an omitted optional argument is otherwise
                    indistinguishable from a decision.
                    An OVERDUE anchor is refused (its debt predates ledger
                    activity already on screen), and "overdue" is a question
                    about the USER's calendar day: the projection is passed
                    todayYmd from financialTodayYmd
                    (frontend/src/lib/financial-today.ts, reached through the
                    useFinancialToday hook), which resolves the stored timezone
                    preference and falls back to the browser zone -- term for
                    term the order RequestContextInterceptor uses to answer
                    todayYMD() for the request that priced the bill. A UTC
                    instant sliced into a day is a third calendar agreeing with
                    neither layer, and inside its window (two hours after local
                    midnight at UTC+2, fourteen at UTC+14, the mirror before
                    midnight west of Greenwich) the report accepted a stale
                    anchor or refused a live one.
                    frontend/src/lib/loan-projection-today.guard.test.ts fails a
                    projection call that does not state its day, one that
                    derives it other than from the user's timezone, and any
                    toISOString() day-slice in the module or its call sites.
                    The rate rule is one truth table
                    (backend/src/accounts/loan-rate-timeline-cases.json)
                    asserted by BOTH layers, since they cannot import each
                    other: effectiveAnnualRateOn here,
                    resolveEffectiveLoanTerms there.
                    The ledger's own inclusion predicate is
                    LEDGER_MOVEMENT_PREDICATE (common/ledger-balance.sql.ts),
                    shared by every balance reader so the bill's debt and the
                    report's balance cannot disagree about which rows count.
Failure response    A template shape the resolver cannot account for (an
                    escrow line, no identifiable interest line) declines: the
                    posting proceeds on the persisted amounts and the
                    recalculation writes nothing, as before. A loan with no
                    active scheduled payment has no anchor, and the report's
                    projection falls back to today's balance one period ahead.
Required tests      Present: scheduled-transaction-loan.service.spec.ts (prior
                    rounded splits deliberately a cent off the balance; the
                    dated query bounded by next_due_date; posting-boundary
                    resolution including idempotence and the decline cases);
                    scheduled-transactions.service.spec.ts (post() writes the
                    ledger-derived allocation, honours an override amount);
                    frontend loan-history.test.ts and
                    LoanAmortizationReport.test.tsx (anchored first projected
                    row equals the bill's interest; anchorless fallback; an
                    anchor overdue in the user's zone refused while UTC still
                    reads yesterday, and one due today kept while UTC already
                    reads tomorrow) and financial-today.test.ts (the day at
                    pinned instants in named zones, so a boundary case does not
                    depend on the runner's TZ).
                    A LINE OF CREDIT is exempt from the paid-off deactivation:
                    it is revolving, so owing nothing this period does not
                    finish it.
                    A retired debt posts NO money -- LoanPostingDecision keeps
                    "nothing to price here" and "the price is zero" apart,
                    because collapsing both into null is how a paid-off loan
                    went on charging its whole stale installment. The debt
                    check runs after the template shape is resolved so a bill
                    carrying a line the payoff does not settle (escrow, tax,
                    insurance) still posts.
Concurrency scope   The scheduled transaction's pessimistic parent lock for the
                    template and the occurrence claim; and, for the debt
                    itself, lockAccountsForBalanceWrite on the source and loan
                    accounts, taken before the ledger read and held to commit
                    (CONC-001 -- the schedule row lock serializes no ledger
                    writer, so it cannot protect an aggregate over
                    transactions). Proven by
                    scheduled-loan-pricing-concurrency.integration.spec.ts
                    (two real connections) plus pricing-lock.guard.spec.ts,
                    which is what ties the protocol to the posting path the
                    integration harness cannot construct.
Scope               MANAGED templates: a principal transfer, one identifiable
                    interest line, optionally an extra-principal transfer. Any
                    other line and the resolver declines rather than rewriting
                    what it cannot account for, so such a bill keeps last
                    period's split. That is a deliberate fail-safe, not
                    coverage -- an escrow/tax/insurance template is outside
                    this invariant until the parent total's non-P/I lines have
                    a defined share.
Known gaps          The PAYMENT is not part of this invariant: a rate change
                    reaches the schedule's payment through
                    LoanRateChangesService.syncScheduledTransaction, which the
                    user is asked to approve, so a declined sync leaves the
                    bill at the old installment by the user's own decision.
                    Interest is unaffected -- it is debt x rate.
Status              enforced
```
### INV-LOAN-HISTORY-001 -- historical loan interest counted as paid is ledger-backed

```text
Statement           Interest attributed to a historical loan payment is a
                    recorded interest split of that payment, or the separate
                    interest expense paired to its date. Absent both, after a
                    SUCCESSFUL read, the interest is a measured zero -- never a
                    figure derived from the balance and the account's rate. A
                    FAILED read is unknown, not zero, and must not be rendered
                    as a schedule.
                    "Ledger-backed" is not enough on its own: the row has to be
                    an INTEREST row. Escrow, property tax, insurance and fees are
                    all ledger-backed and none of them is interest, so the line
                    is identified by provenance -- the loan's configured interest
                    category -- and never by "the split that is not the principal
                    transfer". Changing the order of a payment's split lines must
                    not change Interest Paid.
                    The rate is a separate fact from the interest and does not
                    fall with it: a fixed-rate loan with no recorded rate
                    history keeps its configured rate on a zero-interest row,
                    while a variable-rate loan's rate for that date stays null
                    rather than inheriting today's scalar.
                    And 0% is a rate, distinct from "no rate recorded", at every
                    step: a fixed interest-free loan carries 0 on every row
                    (`Number(null)` is also 0, so the test is `!= null`, never
                    `> 0`), its `principal + 0` installment is COMPLETE rather
                    than partial because the interest is known to be zero, and
                    every surface renders it as `0%` rather than "Not set".
                    A forward PROJECTION may estimate -- that is its job, and
                    its rows are labelled projected. The prohibition is on a
                    historical row.
Source of truth     transaction_splits (the payment's recorded interest leg,
                    identified by accounts.interest_category_id) and the
                    interest-category expenses on the loan's configured source
                    account. Not accounts.interest_rate, which describes the loan
                    and not what any payment settled -- and, for the projection
                    that reads this history, not accounts.interest_rate as the
                    CURRENT rate either: recording a rate change never writes it,
                    so loan_rate_changes at or before today is the current rate.
Enforcement         One producer: frontend/src/lib/loan-history.ts
                    deriveLoanPaymentHistory / classifyPayment, which takes
                    neither the running balance nor the rate timeline as an
                    argument, so there is nothing for an estimate to be computed
                    from. analyticInterest is deleted. The backend computes only
                    forward schedules (accounts/mortgage-amortization.util.ts,
                    for previews and scheduled-payment setup), so no second
                    producer of the historical figure exists.
                    frontend/src/lib/loan-history.guard.test.ts holds two source
                    scans: no catch anywhere in the module, since a swallowed
                    lookup failure resolves to [] and [] is read as "no interest
                    was booked"; and no truthiness read of a resolved annual rate
                    anywhere in frontend/src, since `0` is a rate and five sites
                    rendered a recorded 0% as "Not set". The second carries a
                    self-test over known good and bad lines, because a scanning
                    pattern that quietly matches nothing is worse than no scan.
                    frontend/src/lib/loan-rate-changes.contract.test.ts holds the
                    rate-history endpoint's precondition as one list -- against
                    the backend constant that decides the 400, the two frontend
                    lists that coincide with it, and every caller of
                    loanRateChangesApi.getAll.
Concurrency scope   -- (read path)
Failure response    The rejection propagates to the caller's error-and-retry
                    state: useReportData in the three loan reports, the
                    failedAccountId branch of hooks/useLoanProjection.ts, the
                    page error on the account detail route. A success retires
                    the same account's earlier failure, or the figures stay
                    unavailable after recovery.
Required tests      Present: the principal-only matrix in
                    frontend/src/lib/loan-history.test.ts (every account type x
                    Canadian/variable flag x frequency x rate-timeline
                    presence -- each was a separate door into the estimate), the
                    fixed-rate and variable-rate Rate-column cases, the
                    reconstruction paths re-pinned against RECORDED interest so
                    the Canadian semi-annual and day-count annualizations stay
                    covered, the split-provenance group (escrow before interest
                    and interest before escrow yielding the same figure, the
                    refusal to guess between two uncategorized lines, a transfer
                    leg never counting), the rate-authority group (a stale scalar
                    losing to the timeline, a future-dated row being a step and
                    not the current state), the interest-free group (0% carried
                    on every row while an unconfigured rate stays null, the
                    COMPLETE `principal + 0` installment at 0% against the
                    incomplete one at 6%, and 0% rendering as 0%), the rejection
                    test, the two source scans and the endpoint contract test
                    above, the report's error-and-retry and rate-history-wiring
                    tests in
                    frontend/src/components/reports/LoanAmortizationReport.test.tsx,
                    the failed-rate-history refusal in
                    frontend/src/app/accounts/[id]/page.test.tsx, and the
                    failure-then-refresh-then-success recovery test in
                    frontend/src/hooks/useLoanProjection.test.tsx.
Known gap           **Standalone interest is attributed by `(interest category,
                    source account)`, which is not per-loan.** A loan's separate
                    interest expenses are fetched with exactly that pair
                    (`fetchLoanInterestTransactions`) and nothing on those rows
                    names the loan they belong to. Two loans paid from one
                    account and sharing one interest category therefore merge:
                    each one's history absorbs the other's interest, and
                    `pairSeparateInterestByDate` sums both onto whichever
                    payment date matches. The source comment has always said to
                    give each loan its own category; what makes the state normal
                    rather than exceptional is the DEFAULT --
                    `LoanPaymentSetupService` falls back to
                    `CategoriesService.findLoanCategories`, which resolves one
                    user-level `Loan -> Loan Interest` category for every loan.
                    Worked example: Loan A pays 800 principal + 200 interest and
                    Loan B pays 500 + 100 on the same date from the same
                    chequing account; A's history reports 300 of interest and an
                    1,100 installment instead of 200 and 1,000.
                    Closing it needs a durable provenance link (the loan account
                    id, or the principal payment / scheduled occurrence, recorded
                    on the interest transaction) plus a decision about existing
                    data and about the setup default. Both are schema/product
                    decisions, so the status is `partial` and says so rather than
                    the catalogue claiming a guarantee the code does not give.
                    A second, smaller gap: `accounts.interest_booking_mode`
                    (`AUTO | SPLIT | SEPARATE`) is persisted, offered in the
                    account form and written by the MNY importer, but no reader
                    branches on it -- so it constrains nothing here, and a
                    `SPLIT` loan can still consume a standalone expense. Its
                    cross-layer meaning is undefined and needs a truth table
                    before any reader starts honouring it.
Status              partial -- the estimate is gone and the provenance of a
                    SPLIT-recorded interest line is enforced; the provenance of
                    a STANDALONE interest expense is not.
```

Issue #1255: a $450 principal-only transfer on a $10,000 loan at 6% rendered as
Payment $500 / Principal $450 / Interest $50. The $50 was never paid, and it
reached Interest Paid, every cumulative total, the CSV and PDF exports, and the
installment the forward projection was seeded with.

Two things the estimate was quietly holding up, and both are the interesting
half of the fix. The Rate column was reconstructed *from* the interest charged,
so removing the interest removed the rate as well -- for a fixed-rate loan that
is a known fact being discarded, not an unknown being reported. And
`observedInstallment` returns `principal + interest`, which for a loan
booking its interest outside the app is now under one period's interest, so
`generateLoanSchedule` refuses the seed: `buildLoanProjectionInput` falls back
to the stored contractual payment, and where the rate timeline records the
payment in effect that value is authoritative even when it does not amortize
(`INV-LOAN-HISTORY-001` covers the interest; the payment's authority ordering is
documented in `frontend/CLAUDE.md`).

## Scheduled occurrences

### INV-OCCURRENCE-001 -- one occurrence, one effect

```text
Statement           One scheduled occurrence may create at most one financial
                    effect.
Source of truth     scheduled_transaction_postings, one row per occurrence
Enforcement         A durable occurrence key claimed atomically.
                    processAutoPostTransactions locks the schedule and CAS-checks
                    next_due_date is still due, then claims the occurrence with
                    INSERT INTO scheduled_transaction_postings ... ON CONFLICT
                    (scheduled_transaction_id, original_due_date) DO NOTHING
                    RETURNING id (scheduled-transactions.service.ts), throwing
                    ConflictException on a lost claim. The unique index
                    idx_stp_occurrence (schema.sql, migration 140) is the
                    database-level backstop, so exactly-once holds regardless of
                    replica count; the cron treats the ConflictException as
                    "claimed by another replica".
Concurrency scope   per (scheduled transaction, occurrence date)
Retry semantics     Safe: a re-post is refused by the occurrence claim.
Crash semantics     A crash between claim and advance leaves the claim row, so the
                    next tick is refused rather than reposting.
Failure response    the losing claim gets ConflictException, having posted nothing.
Required tests      The unique index gives DB-level exactly-once; a two-instance
                    "two replicas, one posting" integration test is still owed as
                    the gold-standard proof.
Status              enforced
```

This was `docs/concurrency-and-idempotency.md` CONC-004's canonical case -- the
logical operation key `(scheduledTransactionId, occurrenceDate)` that simply was
not persisted -- and it now is, as scheduled_transaction_postings.

### INV-OCCURRENCE-002 -- a stored override price survives

```text
Statement           A stored override price is not replaced by a market quote
                    without an explicit user action.
Source of truth     scheduled_transaction_overrides.investment_price
Enforcement         The market-price auto-fill is gated. OverrideEditorDialog
                    seeds from the stored value and writes the fetched market
                    price only when investmentPrice is empty (frontend
                    scheduled-transactions/OverrideEditorDialog.tsx), so a stored
                    or inherited price is never overwritten by a differing quote.
Concurrency scope   per occurrence
Failure response    a stored ten-at-100.00 stays ten at 100.00 across a reopen.
Required tests      Present: OverrideEditorDialog.test.tsx -- reopen with a stored
                    price and a differing quote asserts the stored price stands,
                    plus the typed-total-before-close case.
Status              enforced
```

### INV-OCCURRENCE-003 -- one effective occurrence, everywhere

```text
Statement           Every surface that presents or aggregates a scheduled
                    occurrence reports the amount THAT occurrence would post
                    *today*, on the date it actually falls, and reports the
                    amount as unavailable when it cannot be determined. The
                    persisted amount is never substituted, and the recurrence
                    slot is never reported as the due date when an override moved
                    the occurrence off it.
Source of truth     Two files, and only two:
                    common/scheduled-occurrences.ts (expandOccurrenceSlots) owns
                    occurrence IDENTITY -- walking a recurrence over a window and
                    matching each slot to its override. The identity is
                    original_date (the unique index says so); override_date moves
                    the occurrence, and filtering is on the date it falls.
                    ScheduledOccurrenceService (backend
                    scheduled-transactions/scheduled-occurrence.service.ts) owns
                    PRICING: it hydrates each candidate's overrides, asks
                    ScheduledEffectiveAmountService.resolveMany once, and returns
                    EffectiveScheduledOccurrence {amount, currencyCode, complete,
                    dueDate, originalDate, overrideId, settlementAccountId}.
                    ScheduledEffectiveAmountService remains the arithmetic layer:
                    it owns the #1167 stored-if-current-else-resolve decision and
                    the combination of rate and stored scalar.
                    scheduled_transactions.amount is a snapshot at whatever rate
                    was current when it was written.
Enforcement         Server: every occurrence-aware surface consumes the occurrence
                    service -- getLlmUpcomingBillsAndDeposits (AI + MCP),
                    BudgetsService.getUpcomingBills / getVelocity /
                    ensureBillAlerts, BillReminderService,
                    ForecastAggregatorService, BalanceForecastService, and
                    GET /scheduled-transactions/occurrences for clients. findAll
                    still emits effectiveAmount / effectiveAmountComplete /
                    effectiveCurrencyCode / settlementAccountId per schedule (and
                    the amount fields per override), which is a SCHEDULE-level
                    read model: it says what the base occurrence costs, WHOSE
                    balance that costs, and carries the overrides beside it. The
                    account travels with the amount because it is the other half
                    of the answer -- an investment schedule's accountId is the
                    brokerage, so the dashboard's below-zero projection, keyed on
                    that column, warned that a purchase would overdraw an account
                    the trade never moves while the funding account covering it
                    exactly went unprojected.
                    occurrence-selection.guard.spec.ts is the scan, over the files
                    that import the resolver or the occurrence service: a second
                    recurrence loop, a second overrideEffectiveKey lookup, a read
                    of the resolver's `base` outside the two places where the base
                    is the question, a new resolveMany call site, or a direction
                    read of a schedule's stored amount each fail with the file and
                    line. Both matchers are shape-based rather than name-based --
                    `const b = resolved.base` and
                    `Number(b.amount) > 0` inside a `??` expression are the two
                    aliases that slipped past their first versions -- and the
                    base-read and resolver-call allowances are COUNTS per file,
                    asserted to be exactly right so a dead allowance cannot hide a
                    matcher that stopped matching.
                    Client: lib/scheduled-effective-amount.ts is the only reader
                    of those fields (nextOccurrenceEffectiveAmount for a
                    schedule-level surface, nextOccurrenceDueDate for the date it
                    falls on); lib/scheduled-kind.ts occurrenceKind is the only
                    place an occurrence's kind is decided, and the guard scans for
                    the composed `scheduledKind({ amount: x ?? y })` shape it
                    replaced -- `Number(null)` is 0, which paints an unpriceable
                    bill as a grey reminder.
                    lib/scheduled-effective-amount.guard.test.ts scans src/ for
                    the `override.amount ?? …amount` fingerprint, for a client
                    -side recurrence expansion outside its four named exemptions,
                    and for the Upcoming Bills report actually calling
                    getOccurrences (import presence is not proof: the report
                    imported the helper throughout the period it was applying one
                    amount to every occurrence). The same scan fails a
                    `<map>.get(<x>.accountId)` in any file that resolves an
                    occurrence's amount: which account settles is
                    occurrenceSettlementAccountId's answer (the server's
                    settlementAccountId, else the funding or linked cash account),
                    and the two exemptions -- the helper itself and lib/forecast.ts
                    reading the brokerage's own currency -- each record why they
                    address the brokerage on purpose.
Aggregation rule    A total is null when any component is unknown; the partial sum
                    travels in a separately named field (knownUpcoming*Subtotal,
                    knownSubtotal) and never under the total's caption.
                    A total also spans one currency or it spans none: each
                    occurrence is converted into the reporting currency before it
                    joins a sum, and a pair with no rate withholds the total and
                    is NAMED (getVelocity's upcomingBillsMissingRates,
                    LlmUpcomingScheduledResult.missingRatePairs,
                    ConvertedTotal.missingCurrencies) so the reader knows which
                    rate to fix. Backend aggregation goes through FxAggregate,
                    client aggregation through sumConverted /
                    sumEffectiveOccurrences; a currency-blind adder is the defect
                    (the report summed 1,350 CAD beside 500 USD and printed 1,850
                    in the reader's default currency, and the AI/MCP rollup did
                    the same after the report was fixed).
                    A published total also NAMES its currency
                    (LlmUpcomingScheduledResult.totalsCurrency, echoed in the
                    executor's summary line), because the items beside it carry
                    their own settlement currencies. The currency a reader falls
                    back to with no preference row is one constant
                    (FALLBACK_DEFAULT_CURRENCY, backend/src/common/
                    default-currency.util.ts) -- thirteen copies had drifted to
                    two different currencies.
Direction           Bill or deposit, outflow or income, is decided from
                    EffectiveScheduledOccurrence.directionAmount -- the
                    occurrence's own amount when known, the snapshot's sign only
                    when it is not. "An exchange rate is positive, so it cannot
                    flip a sign" holds for one scalar times one rate and fails for
                    a mixed-sign split parent, where only the investment line
                    re-prices: a parent stored at -200 posts +150 once that line
                    moves. Reading the snapshot reported a re-priced deposit as a
                    bill (AI/MCP, the forecast) and a SQL prefilter on
                    `st.amount < 0` dropped the reverse case from the budget
                    entirely. The candidate read therefore narrows on the stored
                    sign only for shapes no rate can move and keeps every
                    FX-sensitive row; the direction is applied after pricing.
                    The client's equivalent is occurrenceKind, which already read
                    the occurrence first.
Concurrency scope   per occurrence; the resolver's FX caches are per read
Failure response    the occurrence renders as unavailable (UnknownAmount, or the
                    localized budgets.alerts.billDue.amountUnavailable copy) and
                    every total containing it is withheld -- never the stale
                    figure, never a measured zero.
Persisted alerts    A BILL_DUE row carries structured data (payeeName, amount,
                    amountComplete, dueDate, originalDate, currencyCode) and the
                    client composes both lines from it, counting the days from
                    `dueDate` against its own clock: the row outlives the day it
                    was written, so a stored "due in 3 days" would go on saying
                    three days. `title`/`message` remain as the English fallback
                    for a consumer with no catalog. `originalDate` is also what
                    decides "already alerted" and what the weekly digest compares
                    `nextDueDate` against -- an override can move an occurrence
                    EARLIER than its slot, and comparing the announced date then
                    reads an unposted bill as paid and drops it from the digest.
Required tests      Occurrence identity and window: scheduled-occurrences.spec.ts
                    (slot-versus-override-date matching, an occurrence moved out
                    of the window, an occurrence moved INTO it from beyond the
                    horizon, end date, remaining count, maxOccurrences ordering).
                    Pricing and selection: scheduled-occurrence.service.spec.ts
                    (override amount wins, a moved override still wins, an
                    unpriceable override stays unknown instead of falling back to
                    the base).
                    Consumers, each with an override case that fails if the base
                    is read: scheduled-transactions.service.spec.ts
                    ("quotes the next occurrence's override amount",
                    "announces the date an override moved the occurrence to",
                    "withholds the bills total when the due occurrence's override
                    cannot be priced"); budgets.service.spec.ts (getVelocity
                    override + moved-date + moved-out-of-period, and the alert
                    path's moved occurrence and its identity-based dedup);
                    bill-reminder.service.spec.ts (override amount and override
                    date in the email); forecast-aggregator.service.spec.ts;
                    balance-forecast.service.spec.ts (settlement account, unknown
                    rate withholding the series, per-occurrence overrides) and
                    balance-forecast.util.spec.ts.
                    Frontend: UpcomingBillsReport.test.tsx (per-occurrence
                    override in the list, the calendar, the CSV and the PDF, and
                    an unresolvable occurrence withholding the total),
                    NotificationList.test.tsx (localized bill-due copy, including
                    the unavailable-amount case), UpcomingBills.test.tsx and
                    BudgetUpcomingBills.test.tsx (moved next occurrence),
                    plus scheduled-utils, BudgetVelocityWidget,
                    RecurringChargesPanel (including the date an override moved
                    the occurrence to, which the panel sorted by and printed the
                    slot for) and ScheduledTransactionList.
                    Direction and currency: scheduled-occurrence.service.spec.ts
                    (a mixed-sign split parent whose effective sign flips, both
                    ways, plus the unpriceable fallback),
                    scheduled-transactions.service.spec.ts (the AI/MCP kind),
                    forecast-aggregator.service.spec.ts (isIncome),
                    budgets.service.spec.ts (a CAD occurrence converted into a USD
                    budget, and a missing display rate withholding the total),
                    scheduled-effective-amount.test.ts (conversion before summing)
                    and UpcomingBillsReport.test.tsx (a mixed-currency total and
                    the CSV currency column).
                    Each mutant these exist for was confirmed to fail them: base
                    instead of override, and keying the override on override_date.
Settlement account  An occurrence is charged to the account that actually moves
                    the cash. `EffectiveScheduledOccurrence.settlementAccountId`
                    carries it, derived through
                    `InvestmentTransactionsService.resolveSettlementAccountId` --
                    the same decision the posting makes, and the one the currency
                    pair is derived from, so the account and its currency cannot
                    disagree. A scheduled investment's `accountId` is the
                    brokerage, so `BalanceForecastService` keyed on that column
                    charged the brokerage for cash it never moved and left the
                    funding account's own chart missing the outflow it pays; the
                    amount alone could not have fixed it.
Cumulative series   A projected balance is cumulative, so an occurrence nobody can
                    price makes every point after it wrong. `BalanceForecastResult`
                    withholds the forward line (`complete: false`, only today's
                    anchor) and names the schedules in `gaps`; the client draws
                    `BalanceForecastUnavailable` instead of a stub line and reports
                    the projected-balance card as unavailable rather than falling
                    back to today's figure. Completeness is decided from the
                    occurrences that actually landed in the window, so an
                    unpriceable schedule with no occurrence inside it does not
                    withhold anything.
                    A `crossCurrencyTransfer` gap is a separate cause with its own
                    copy: the schedule's amount is the SOURCE account's, the
                    arriving amount is resolved at posting, and this endpoint
                    applies no rate -- so the destination's projection reports it
                    rather than adding a foreign number (INV-FX-001's rule applied
                    to a projection).
Known scope         Two client-side expansions remain, both named in the frontend
                    guard's exemption list with their reasons: `lib/forecast.ts`
                    (the cash-flow forecast, which resolves each occurrence
                    against `futureOverrides` and the effective-amount contract --
                    it is the surface the others were wrong against) and the bills
                    calendar in `app/bills/page.tsx` (which draws names on dates
                    and prints no amount per occurrence). A third,
                    `OccurrenceDatePicker`, offers dates to attach an override to.
                    The AI forecast summary describes every active schedule, so it
                    asks for one occurrence per schedule over a deliberately wide
                    horizon (FORECAST_OCCURRENCE_HORIZON_DAYS) rather than a
                    product window.
Status              enforced
```

## Authentication and authorization

### INV-CLAIM-001 -- a claim token is consumed exactly once

```text
Statement           An emergency-access claim token may be consumed successfully
                    exactly once.
Source of truth     emergency_access_contacts.claim_token_used_at
Enforcement         A single conditional UPDATE consumes the token before any
                    credential is touched. emergency-access-claim.controller.ts
                    runs UPDATE ... SET claim_token_used_at = CURRENT_TIMESTAMP
                    WHERE claim_token_hash = $1 AND claim_token_used_at IS NULL
                    AND claim_token_expires_at >= CURRENT_TIMESTAMP RETURNING; a
                    zero-row result is a NotFoundException, so the loser of two
                    concurrent completes writes nothing and rewrites no password.
Concurrency scope   per token, per owner
Retry semantics     Safe: the second complete finds the token consumed and is
                    refused.
Failure response    the loser gets 404, having written nothing --
                    docs/financial-calculation-contract.md section 7.
Required tests      Present: emergency-access-claim.controller.spec.ts asserts the
                    loser (a zero-row consume) is refused. A two-connection test is
                    the gold-standard proof still owed.
Status              enforced
```

### INV-AUTH-001 -- refresh rotation

```text
Statement           A presented refresh token rotates once; a second presentation
                    revokes the family.
Source of truth     refresh_tokens.is_revoked, per family_id
Enforcement         Pessimistic write lock on the RefreshToken row by tokenHash,
                    plus family revocation on a token already revoked. The loser
                    blocks on the lock, sees the winner's committed isRevoked,
                    and takes the reuse-detection branch.
Concurrency scope   per token family
Retry semantics     A retried rotation of the same token is reuse, not a retry,
                    and is treated as such by design.
Crash semantics     A crash before commit leaves the presented token valid; a
                    crash after leaves the successor valid. Both are consistent.
Failure response    401, family revoked.
Required tests      Two-connection: two concurrent rotations of one token; assert
                    the family ends revoked rather than two live successors.
Status              enforced
```

Recorded as enforced because the mechanism is real and correct -- and because it
is subtle enough that a future refactor could remove the lock without any test
noticing.

### INV-AUTH-004 -- a logout reports only what it achieved

```text
Statement           A logout that did not revoke the session must not be presented
                    to the user as a completed logout.
Source of truth     refresh_tokens.is_revoked for the family
Enforcement         The handler awaits the revoke before reporting success, and
                    the revoke is locked. auth.controller.ts logout awaits
                    revokeRefreshToken (under withSystemContext) before
                    clearAuthCookies and the success body, with no try/catch, so a
                    revoke failure propagates and is never presented as a completed
                    logout. The family revoke takes lockTokenFamily before its
                    UPDATE (token.service.ts revokeTokenFamily), so it is a real
                    protocol rather than the value's order-independence.
Concurrency scope   per token family
Retry semantics     Safe: setting is_revoked twice is a no-op.
Failure response    a failed revoke surfaces as an error, not a cleared session.
Required tests      Failpoint (the load-bearing kind per docs/verification-contract.md):
                    backend/test/integration/logout-revoke-failpoint.integration.spec.ts
                    forces the family-revocation write to fail with a BEFORE UPDATE
                    trigger and asserts the real revokeRefreshToken rejects and the
                    family stays live, with a control case proving the same call
                    revokes when nothing blocks it. Unit (supporting):
                    auth.controller.spec.ts asserts the controller propagates that
                    rejection without clearing cookies or emitting the success body.
                    Still owed: the user-visible E2E assertion.
Status              enforced
```

Split out from INV-AUTH-001 because the two are different properties that happen
to touch the same table. Rotation is about exactly-once; this is about truthful
reporting, and conflating them hid the fact that only the first has a mechanism.

### INV-AUTH-002 -- every failed login is counted

```text
Statement           A failed login attempt increments the counter the lockout
                    threshold reads.
Source of truth     users.failed_login_attempts
Enforcement         An atomic CTE increments in the database. recordFailedAttempt
                    (auth.service.ts) runs one UPDATE users SET
                    failed_login_attempts = failed_login_attempts + 1 with the
                    lockout threshold folded into the same statement -- not a
                    JavaScript read-modify-write across the bcrypt compare -- so
                    two concurrent failures cannot lose an increment. The
                    success-path reset writes a fixed absolute value and was always
                    safe.
Concurrency scope   per account
Failure response    the counter equals the number of failures; lockout is not
                    delayed.
Required tests      Present: auth.service.spec.ts asserts recordFailedAttempt is
                    the single incrementing statement (matched on
                    failed_login_attempts + RETURNING). A two-connection "N
                    concurrent failures, counter equals N" test is still owed.
Status              enforced
```

### INV-AUTH-003 -- a destructive OIDC action needs a real round trip

```text
Statement           Restore, delete-account, delete-data and step-up on an OIDC
                    account require a signed proof of a fresh identity-provider
                    authentication, bound to the user and the action, single-use
                    and short-lived.
Source of truth     the identity provider
Enforcement         A signed, single-use, short-lived reauth artifact bound to
                    the user and action. OidcReauthService.issue mints an HS256
                    JWT bound to sub + purpose + jti with a 5-minute TTL;
                    consume verifies signature, type, subject, action and exp,
                    then claimJti runs INSERT ... ON CONFLICT (jti) DO NOTHING
                    RETURNING (single-use across replicas), and isFreshAuthentication
                    requires a real IdP round trip via auth_time. Step-up's
                    client-asserted boolean is gone (step-up.service.ts calls
                    oidcReauth.consume). Wired into destructive routes
                    (users.service.ts, backup-restore.service.ts).
Concurrency scope   per user, per action
Failure response    401 until a valid, unspent, unexpired proof is presented.
Required tests      Present: OidcReauthService specs cover forge/replay/expiry and
                    the single-use jti claim.
Status              enforced
```

The old sentinel string 'oidc-session-confirmed' survives only in comments and
superseded tests; `docs/verification-contract.md` section 5 (known-wrong tests)
covers retiring those.

### INV-ACTIVITY-001 -- activity is attributed to whoever acted

```text
Statement           users.last_activity_at records the authenticated user who
                    made the request, never the user they are acting as.
Source of truth     the authenticated principal (req.user.realUserId)
Enforcement         The interceptor stamps the authenticated identity.
                    request-context.interceptor.ts calls
                    touchLastActivity(realUserId), where realUserId =
                    user?.realUserId ?? userId, and the write targets
                    { id: realUserId } -- so a delegate acting on an owner's data
                    stamps the delegate's row, not the owner's.
Concurrency scope   per user
Failure response    --
Required tests      Present: request-context.interceptor.spec.ts asserts the
                    update targets the delegate's id while acting, leaving the
                    owner's row untouched.
Status              enforced
```

This is not a cosmetic attribution bug. Emergency-access eligibility is computed
from `lastActivityAt` -- the whole feature is "the owner has not been seen for N
days". A delegate with routine access keeps resetting that clock, so the grant
that is supposed to fire never does, and the safeguard fails silently in the
direction that withholds access from the people it exists for.

### INV-PROFILE-001 -- a profile response is an allowlist

```text
Statement           Every user-profile response is built by naming the fields to
                    include, never by removing the fields to hide.
Source of truth     the User entity
Enforcement         An allowlist, not a removal list. users/user-profile.ts
                    builds every profile response by copying only PROFILE_FIELDS
                    (typed `satisfies readonly (keyof User)[]`); a new column is
                    absent by default until someone names it there.
                    toDelegatedUserProfile additionally drops the owner's
                    credential-state fields for an acting delegate.
Concurrency scope   per user, and per delegate
Failure response    --
Required tests      Present: users/user-profile.spec.ts proves the allowlist is
                    exact, drops every @Exclude() column (read off
                    class-transformer metadata via user-profile.test-util.ts's
                    fullyPopulatedUser with LEAK- sentinels), and source-scans
                    src/ for a removal-list sanitizer anywhere.
Status              enforced
```

A removal list would be wrong structurally: the default for a new column is
"exposed", so the defect could be introduced by a change that never touches this
file, and the route is delegate-accessible so the leak would cross users. The
allowlist inverts that default.

### INV-DISPLAY-001 -- a figure is rendered in the reader's number locale

```text
Statement           Any number addressed to a PERSON -- money, a percentage, a
                    share count, a price, a plain count -- is rendered in that
                    person's effective number locale, on every surface that shows
                    it: the app, a PDF or CSV export, an email, a notification, a
                    generated report note. The effective locale is one
                    resolution, shared by both layers: an explicit
                    `user_preferences.numberFormat` wins; `"browser"` falls back
                    to `user_preferences.language`; a language that is not a real
                    Intl tag (`browser`, the `xx` pseudo-locale) falls through --
                    to the browser on the client, which has one, and to
                    DEFAULT_LOCALE on the server, which does not.
                    A fixed locale is permitted only where the output is read by
                    a MACHINE and the contract is documented: an LLM prompt, and
                    the English fallback string stored on a row whose client
                    composes its own copy from the structured payload beside it.
                    "It is already localized" is not a defence for
                    `toLocaleString()`: that follows the browser, and an explicit
                    numberFormat exists to override the browser -- a reader on
                    en-US hardware who chose pl-PL still gets `12,345`.
Source of truth     frontend/src/hooks/useNumberFormat.ts getEffectiveLocale;
                    backend/src/common/number-locale.util.ts resolveNumberLocale
Enforcement         Client: every figure goes through useNumberFormat(); a pure
                    module takes its NumberFormatters as an argument.
                    frontend/src/test/number-locale.guard.test.ts scans src/ for
                    four fingerprints -- a UI file importing the raw
                    formatCurrency/formatShareQuantity from @/lib/format, a
                    numeric toLocaleString(), a literal '%' beside an
                    interpolation, and an Intl.NumberFormat built on 'en-US' or
                    on `undefined` (the browser, which an explicit preference
                    exists to override) -- with a classified allowlist and a
                    comment stripper so the prose that has to NAME the banned
                    patterns does not trip its own scan.
                    The percentage scan is keyed on the literal '%' rather than
                    on `toFixed`: written from the diff it matched only the
                    shapes the migration had just removed and reported clean over
                    fourteen survivors, because the codebase's commonest shape
                    (`{percentage}%`) names no formatter at all.
                    Server: numberFormatterFor(numberFormat, language) built from
                    the recipient's preference row, passed into the email
                    templates, the budget-alert and bill-due message builders,
                    the portfolio-movement push body, the anomaly-report
                    descriptions and the monthly-comparison notes.
                    backend/src/common/number-locale.guard.spec.ts holds the
                    classification of every caller of the en-US helpers (each
                    with the reason its output is not addressed to a person),
                    fails on a second hardcoded en-US formatter in src/, and runs
                    the same literal-'%' scan over the server -- excluding CSS
                    lengths, SQL LIKE wildcards and logger arguments, the last by
                    blanking whole logger CALLS, since a multi-line log message
                    puts the '%' nowhere near the logger call that names it.
Concurrency scope   per reader
Failure response    An unknown currency code costs the SYMBOL and keeps the
                    reader's separators.
                    A stored preference Intl cannot use at all is a different
                    case and is resolved BEFORE any formatter is built: `en_US`,
                    the underscore form, makes Intl.NumberFormat throw RangeError,
                    and nothing validated the column. The server falls back to
                    DEFAULT_LOCALE, the client to the browser (which is what an
                    absent preference already means). Catching the throw at the
                    call site is not enough and was the first fix's mistake: its
                    fallback rebuilt Intl from the same locale and threw too,
                    which 500'd a report and silently stopped that user's bill
                    reminders and budget alerts. IsNumberLocale on the DTO stops
                    new such values; the two fallbacks cover rows already stored.
Required tests      Present: useNumberFormat.test.ts (share quantity at 8dp under
                    pl-PL and en-US, tiny residual preserved, -0 normalized;
                    formatPercentTrimmed keeping 80 / 80.5 / 80.55 as they are;
                    an unusable stored locale rendering rather than throwing);
                    is-number-locale.validator.spec.ts;
                    SecurityList.test.tsx "number locale" (the reported screen,
                    under pl-PL, en-US chosen while the UI is Polish, browser
                    fallback, and one case where the preference deliberately
                    disagrees with the host locale); number-locale.guard.spec.ts
                    (the resolver's truth table and pl-PL/en-US rendering);
                    email-templates.spec.ts "recipient number locale" (a Polish
                    bill reminder). A component test must not build its
                    expectation with the same helper the component renders
                    through -- SecurityList.test.tsx did, which is why the defect
                    shipped green.
Status              enforced
```

The number locale is a SEPARATE preference from the language, and that is the
part a mechanical fix gets wrong twice over. Replacing a hardcoded `en-US` with
`toLocaleString()` looks like a migration and is not -- it swaps one wrong locale
for another, and the new one happens to be right on the developer's machine.
Localizing the figure while leaving the sentence in English is right in one place
and wrong in another: it is right inside a stored English FALLBACK a client
overrides, and wrong as a substitute for putting the copy in a catalogue. Both
halves are decided per surface, and the classification is what the guard holds.

### INV-MCP-001 -- identity comes from the credential on the request

```text
Statement           An MCP request is served as the user of the credential
                    presented ON THAT REQUEST, with that credential's current
                    scopes. No tool reads identity from a session, from tool
                    arguments, or from anywhere else. A 2025-era session is
                    additionally bound to the credential that opened it.
Source of truth     backend/src/mcp/mcp-context.ts resolveUserContext
Enforcement         mcp-http.controller.ts authorize() runs validatePat per
                    request and attaches the result as the SDK AuthInfo; a
                    handler reads it through resolveUserContext(ctx), which
                    validates the shape rather than trusting it. A credential
                    that cannot be identified (an OAuth grant with no id) is
                    refused 403 rather than served, because it can be bound to
                    nothing. On the 2025-era path authorizeExistingSession also
                    refuses with 403 unless the session's credentialId matches
                    the presented one (not just the userId), which is what stops
                    a read-only token inheriting a write session's scopes. A
                    revoked token 401s immediately rather than at session TTL.
                    The 2026-07-28 revision has no session at all, so the
                    per-request rule is the whole rule there.
Concurrency scope   per request; additionally per session on the 2025-era path
Failure response    401 for an unknown credential; 403 for one that cannot be
                    identified or does not match its session.
Required tests      Present: mcp-context.spec.ts covers the AuthInfo round trip,
                    the unbindable credential, and a malformed authInfo refusing
                    rather than resolving a partial user. mcp-http.controller.spec.ts
                    covers the 403 credential-mismatch and session/user-mismatch
                    cases, and asserts a 2026-07-28 request is served with its
                    own authInfo and touches no session. mcp-eras.spec.ts drives
                    both revisions against the real SDK and asserts the tool
                    resolves the caller from the request.
Status              enforced
```

### INV-MCP-002 -- an MCP request is answered by the MCP transport

```text
Statement           A request addressed to the MCP server is answered by the MCP
                    transport or refused by it. The Next.js application shell
                    never answers one, so an unauthenticated probe receives the
                    transport's own 401 rather than a page.
Source of truth     frontend/src/proxy.ts isRootMcpRequest
Enforcement         The proxy forwards a request to "/" to /api/v1/mcp when it
                    carries an event-stream Accept, an Authorization: Bearer
                    header, Mcp-Session-Id, MCP-Protocol-Version, Mcp-Method or
                    Mcp-Name. Before the bearer clause a probe carrying only a
                    bad token matched nothing, fell through to the app, and was
                    answered 307 -> 200 -- indistinguishable from a server
                    accepting an invalid token. mcp-http.controller.ts
                    validatePat refuses every malformed or unknown bearer with a
                    401 plus the RFC 9728 WWW-Authenticate header.
Failure response    401 from the MCP endpoint, naming resource_metadata.
Required tests      Present: proxy.test.ts covers the bearer probe (asserting the
                    401 reaches the caller), the case-insensitive scheme, the
                    Mcp-Method header, and that a cookie-authenticated browser
                    navigation still redirects to /login. Both bearer cases were
                    confirmed to fail without the clause.
                    mcp-http.controller.spec.ts covers nine malformed and unknown
                    Authorization shapes across POST, GET and DELETE.
Status              enforced
```

### INV-MCP-003 -- a write confirmation is bound to one credential and one change

```text
Statement           A confirmation a user gave authorizes exactly the change
                    they were shown, asked of exactly the credential that was
                    asked. It cannot be replayed by another caller, against
                    another tool, or re-aimed at a different change. It is
                    deliberately NOT single-use: the same seal and answer, from
                    the same credential against the same tool inside the TTL,
                    commits again -- the answer is client-asserted on this
                    revision, so a client able to replay one could equally have
                    fabricated it, and the seal bounds who and what rather than
                    how many times.
Source of truth     backend/src/mcp/mcp-request-state.ts,
                    backend/src/mcp/mcp-confirm.ts
Enforcement         On the 2026-07-28 revision the confirmation spans two calls
                    and the server holds nothing between them, so what carries
                    it is a signed requestState (HMAC-SHA256, ten-minute TTL)
                    bound to the request's credential and method. The SDK seam
                    verifies it BEFORE any handler runs and refuses a bad,
                    expired or foreign one with -32602. The seal also carries a
                    fingerprint of the items the user was shown; the round that
                    writes recomputes it from what it re-derived and throws
                    ConfirmMismatchError on any difference, so a retry that
                    resolved a name to another row or altered an amount writes
                    nothing. What is fingerprinted is the change and not the
                    round it was built in: roundStableAction (mcp-confirm.ts)
                    drops the fields the builder mints per build -- actionId and
                    expiresAt, named once by AI_ACTION_ENVELOPE_FIELDS beside
                    the descriptor and typed so the compiler refuses a new one
                    off the list, plus an attachment's parking slot, whose file
                    stays identified by sha256/filename/contentType/byteSize.
                    Hashing the descriptor raw makes every fingerprint unique
                    and refuses every confirmed write. The payload is signed,
                    not encrypted, so it holds the fingerprint and nothing else.
Concurrency scope   per confirmation flow
Failure response    -32602 from the seam for a bad seal; a tool error naming the
                    mismatch, with no write, for a re-aimed retry.
Required tests      Present: mcp-confirm.spec.ts covers the ask/answer matrix, a
                    fingerprint mismatch, a key-set mismatch, and a seal
                    replayed under another credential or another method, and
                    drives the REAL AiActionBuilderService twice to assert the
                    fingerprint holds across rounds while still separating two
                    different changes (a double that returns one frozen object
                    agrees with itself whatever is hashed, which is how the
                    unstable fingerprint shipped green).
                    transactions.tool.spec.ts drives both rounds of a real write
                    through a builder double that mints a fresh envelope per
                    call, as the real one does.
                    mcp-migration.guard.spec.ts asserts the sealed payload
                    carries nothing but the fingerprint, that the fingerprint is
                    taken over the round-stable projection, and that no tool
                    maps its own confirmation cards.
Status              enforced
```

### INV-MCP-004 -- a write happens only on the round a human answered

```text
Statement           A write reaches the database only after a user's answer is
                    read. An unanswered, declined or cancelled confirmation
                    writes nothing, on either protocol revision.
Source of truth     backend/src/mcp/mcp-confirm.ts
Enforcement         On 2026-07-28 the first round RETURNS the question
                    (resultType input_required) and writes nothing; only the
                    round carrying inputResponses can write, and anything that
                    is not an accepted elicitation -- declined, cancelled,
                    missing, dropped, or a response of another kind -- is read
                    as "declined". A client that fulfils nothing never calls
                    back, so nothing is written. On a 2025-era connection the
                    server waits for the dialog and refuses on any answer that
                    is not an accept, except where the client demonstrably
                    cannot show one ("unsupported"), where the client's own
                    per-tool approval prompt is the consent step.
Concurrency scope   per tool call
Failure response    A tool error naming the refusal; no write.
Required tests      Present: mcp-confirm.spec.ts covers every non-accept answer.
                    mcp-eras.spec.ts drives a real 2026-07-28 client that
                    accepts, declines, and never answers, asserting the write
                    happened only in the first case. The write-tool specs cover
                    the same on both rounds.
Status              enforced
```

### INV-CURRENCY-001 -- shared currency deletion

```text
Statement           A shared currency row is deleted only by its creator, and only
                    when a global reference count -- covering every foreign key in
                    the schema -- is zero, decided under a lock in the deleting
                    transaction.
Source of truth     currencies, and every table referencing currency_code
Enforcement         Creator-only, on a genuinely global count, under a lock.
                    CurrenciesService.removeWithin gates the currency-row delete on
                    createdByUserId === userId (a non-creator deactivates their own
                    preference but never takes the shared row), locks the currency
                    row with SELECT ... FOR UPDATE, and asks the SECURITY DEFINER
                    function currency_code_in_use_globally (migration 137) which
                    covers every FK including budgets and both exchange_rates
                    columns -- not the caller's tenant-scoped count.
Concurrency scope   global -- cross-tenant
Failure response    non-creator deactivates without deleting; 409 while referenced.
Required tests      Present: currency-references.spec.ts derives the reference list
                    from schema.sql in both directions so a new FK cannot be
                    forgotten; currencies.service.spec.ts asserts a non-creator's
                    remove deletes only the preference and never the currency row.
                    A two-connection delete-versus-use test is still owed.
Status              enforced
```

The global count is a SECURITY DEFINER function precisely so that under
`RLS_MODE=enforce` it does not degrade to a tenant-scoped count that sees only the
caller's rows and reports zero for another user's references.

## External effects

### INV-ATTACHMENT-001 -- metadata resolves to committed bytes

```text
Statement           Attachment metadata that a user can see resolves to bytes
                    that are durably present, and no bytes exist without
                    metadata.
Enforcement         Ordered so a failure leaves recoverable bytes, never a row
                    promising absent bytes. attachments.service.ts commits an
                    upload-intent tombstone on its own connection before the put,
                    compensates on rollback (storage.delete + clear the intent),
                    and distinguishes the database provider's joint commit from
                    external providers via objectWritten. A reconciliation job
                    exists: attachment-orphan-sweeper.service.ts (hourly, under
                    withSystemContext) claims tombstones and deletes leased-past
                    orphaned bytes. Local writes are crash-atomic
                    (local-storage.provider.ts writeFileAtomic). "No bytes without
                    metadata" holds eventually rather than instantaneously, which
                    is what the invariant asks.
Concurrency scope   per attachment
Retry semantics     Deletes are idempotent on a missing key; a failed create's
                    bytes are swept.
Crash semantics     A transient orphan on rollback is durably recoverable by the
                    sweeper, not silent.
Status              enforced
```

### INV-ATTACHMENT-002 -- a scan pair is one attachment

```text
Statement           A scanned document and the unprocessed photo it came from
                    are one attachment to every reader: one row in the list,
                    one against the per-transaction cap, one in the register's
                    attachment count, one in the has-attachments filter. They
                    are written together or not at all, and deleting the
                    visible one deletes the original.
Enforcement         `transaction_attachments.original_of_attachment_id` is set
                    on the ORIGINAL and points at the visible row, so "a
                    visible attachment" is `IS NULL` on that column -- written
                    once in `backend/src/attachments/primary-attachment.util.ts`
                    and used by all four readers, with
                    `primary-attachment.guard.spec.ts` failing a second copy.
                    The link carries ON DELETE CASCADE and a partial unique
                    index (at most one original per attachment); a CHECK stops
                    a row being its own original. Both rows and both objects
                    are written inside one `withScopedDb`, the visible row
                    first because the foreign key is immediate, each object
                    behind its own upload intent so INV-ATTACHMENT-001 holds
                    per object. `remove` deletes both and returns both storage
                    keys, so the bytes are swept immediately rather than by the
                    hourly pass.
Concurrency scope   per transaction (the cap is counted under its row lock)
Retry semantics     A failed pair leaves neither row; the compensation deletes
                    whichever objects were written, and any it cannot reach are
                    swept from their intents.
Crash semantics     A crash between the two writes rolls both back; the
                    intents outlive the process, so neither object is orphaned
                    undiscoverably.
Status              enforced
```

### INV-PAYEE-001 -- a contact lookup never overwrites the user's value

```text
Statement           A looked-up website, address, email or phone is written only
                    into a column that is NULL at the moment of the write; a
                    value the user entered, before or during the lookup, is
                    never replaced. The automatic (background) lookup runs at
                    most once per payee across replicas and retries.
Source of truth     The payees row: the four contact columns, contact_lookup_at
                    (the attempt) and contact_lookup_source (which lookup wrote
                    at least one field).
Enforcement         One statement, ENRICHMENT_UPDATE_SQL in
                    payee-contact-enrichment.service.ts: every contact column is
                    COALESCE(column, $n); contact_lookup_source moves only when
                    the statement itself set a field (the CASE reads the
                    pre-SET column values); the automatic path adds WHERE
                    contact_lookup_at IS NULL. The read that precedes it (whose
                    only job is to say which fields THIS write set) takes the
                    row's write lock, FOR UPDATE, and holds it to the commit,
                    so the two statements are one decision rather than a
                    check-then-act a concurrent user edit can land inside. The provider call runs outside any
                    transaction and PayeesService.create dispatches it only after
                    its own withScopedDb resolved with no ambient manager
                    (getActiveScopedManager() === undefined). The AI/MCP preview
                    looks up before the card and hands its stamp to the commit,
                    which stores it instead of looking up again. A client that
                    will show the answer for confirmation says so on the create
                    (CreatePayeeDto.deferContactLookup, read by
                    PayeesController as a CreatePayeeOptions field and never
                    stored on the row), so the background lookup does not pay
                    for a second call nor write values the user is still being
                    asked about: the transaction page's payee quick-create runs
                    POST /payees/:id/lookup-contact itself and opens the same
                    confirmation dialogue. The form path persists nothing until
                    the user saves.
                    A lookup given the payee's own stored details may answer with
                    a FULLER value for a field that already has one (the branch
                    address behind a stored "Toronto"), and may answer with more
                    than one candidate where the name means more than one
                    organisation or branch. Neither reaches the row by itself.
                    POST /payees/:id/lookup-contact WRITES NOTHING -- it returns
                    the candidates (PayeesService.lookupContactForPayee), the
                    detail screen shows them in a confirmation dialogue naming
                    each field as an add or a replace beside the value it would
                    replace, and the user's confirmation goes through
                    PATCH /payees/:id as their own edit. That is the only path by
                    which a looked-up value replaces a stored one, and it is a
                    user edit rather than a lookup write. A suggested value equal
                    to what the user already holds is dropped by
                    sanitizeContactSuggestion rather than counted; a fuller one is
                    named in PayeeContactSuggestion.refined, which the payee form
                    uses to replace-and-undo before Save.
Concurrency scope   per payee
Retry semantics     A re-dispatch, a second replica or a retried request matches
                    zero rows on the automatic path; the user-initiated re-run
                    omits the contact_lookup_at predicate and still only fills
                    gaps. A failed attempt stamps nothing, so it may be retried.
Crash semantics     A crash before the UPDATE leaves the row untouched and
                    unstamped (a later attempt runs); after it, the row is
                    complete. The favicon that follows a looked-up website is a
                    separate best-effort write keyed on that website.
Failure response    The coordinator never throws: disabled / no_provider /
                    failed / none are returned and shown distinctly; a failure is
                    never presented as "nothing found". `none` is an answer --
                    the source looked and had nothing, which for the AI adapter
                    means a parsed `{"matches": []}` -- and it is the reason
                    that STAMPS contact_lookup_at. An answer that could not be
                    read is not that: an empty turn (a web search paused past
                    its continuation limit returns content ""), an output cut
                    off at PAYEE_LOOKUP_MAX_TOKENS, or a relay agent replying in
                    prose is `failed`, which stamps nothing. Collapsing the two
                    retires the automatic lookup for that payee for good.
Required tests      payee-contact-enrichment.service.spec.ts (COALESCE and
                    predicate shape, stamp-on-answer only, favicon keyed on the
                    website), payees.service.spec.ts (dispatch after the
                    transaction, never inside one, never with a supplied field
                    or a preview stamp, never when the caller defers it, notes
                    carried in as context, and the detail-screen lookup writing
                    nothing), payees.controller.spec.ts (deferContactLookup
                    travels as an option, never as a payee field),
                    contact-suggestion.sanitize.spec.ts (a refinement is named,
                    an echo is dropped, candidates are capped and must be
                    distinguishable), lookup-context.spec.ts (what leaves the
                    row for the prompt), frontend PayeeForm.test.tsx (a replaced
                    field is named separately and the undo restores what the user
                    typed) and PayeeKeyInfoCard.test.tsx (nothing is written
                    until the dialogue is confirmed, a cancel writes nothing, and
                    the picked candidate is the one saved),
                    TransactionForm.test.tsx (a payee created there defers the
                    background lookup, runs its own and saves nothing until the
                    dialogue is confirmed), raw-sql-columns.spec.ts (column names
                    against schema.sql),
                    ai-payee-contact-lookup.provider.spec.ts (an unreadable
                    answer fails rather than reporting nothing found, and a
                    parsed empty answer still reports none). Owed: a
                    two-connection integration race proving the FOR UPDATE read
                    against a concurrent user edit, per
                    docs/verification-contract.md.
Status              enforced
```


### INV-PAYEE-002 -- the Google Places monthly cap is never exceeded

```text
Statement           The number of Google Places requests made in one PACIFIC
                    calendar month never exceeds the cap configured for the key
                    that pays for them. Pacific because that is the month
                    Google's free allowance resets on (midnight Pacific on the
                    1st); a cap counted in any other zone rations a window that
                    is not the one being billed. A user's own key is capped per user; the
                    operator's key (GOOGLE_PLACES_API_KEY) is capped once for
                    the whole deployment, because one key is one bill.
Source of truth     payee_lookup_usage(user_id, month).google_places_requests
                    for a user's key; google_places_instance_usage(month).requests
                    for the operator's.
Enforcement         One statement per scope, in PayeeLookupQuotaService.claim: an
                    INSERT ... ON CONFLICT DO UPDATE SET requests = requests + 1
                    WHERE $cap_disabled OR requests < $cap, RETURNING the new
                    count. The predicate is part of the write, so a second
                    claimant blocks on the first's row lock inside the statement
                    and re-evaluates against the committed value -- there is no
                    window between a read and a write. Zero rows back is the cap
                    being reached, and the caller falls back to the AI adapter.
                    The month is to_char(now() AT TIME ZONE
                    'America/Los_Angeles', 'YYYY-MM') -- the zone named once as
                    GOOGLE_PLACES_QUOTA_TIMEZONE and passed as a bind parameter
                    -- evaluated by PostgreSQL, so every replica rolls over on
                    one clock AND on the same instant Google's allowance does.
                    A named zone rather than a fixed offset because Pacific
                    observes DST. The claim runs through runOutsideActiveScopedManager
                    and commits BEFORE the request leaves: Google bills an
                    attempt whatever comes back, so a slot released because the
                    request then failed would under-count what is being paid for.
                    The operator's counter is claimed under withSystemContext
                    (the table is RLS-exempt, having no owner); a user's counter
                    is an ordinary policied row.
Concurrency scope   per user for a user's key; per deployment for the operator's
Retry semantics     Each attempt claims its own slot. A retry after a failed
                    request spends another, which is correct: Google billed both.
Crash semantics     A crash after the claim and before the request spends a slot
                    for a request nobody made -- the survivable direction, since
                    the alternative over-spends a paid quota.
Backup/restore      payee_lookup_usage is exported and restored so a month's
                    spend follows the user's key to another machine, and it is
                    the one table in PRESERVED_ON_RESTORE: the restore does not
                    clear it, so ON CONFLICT DO NOTHING gives the archive's
                    count to a machine with no row and leaves a live count
                    alone. No restore can lower a count and hand back spent
                    quota. google_places_instance_usage is not exported: it has
                    no owner and every user on the deployment spends it.
Failure response    ContactLookupOutcome.reason = "quota_exceeded" when the cap
                    is spent AND no AI provider can answer; otherwise the lookup
                    silently falls back to the AI adapter. A pinned AI provider
                    (payee_lookup_settings.ai_provider_config_id) that resolves
                    to nothing reports "no_provider" rather than falling through
                    to a model the user did not choose. payee_lookup_settings.ai_enabled
                    = false is the same answer reached earlier: the AI adapter is
                    not asked at all, so a spent cap is "quota_exceeded" with no
                    model call behind it, and Places being unreachable as well is
                    "no_provider".
Required tests      Two-connection: concurrent claims over the last slot, one
                    winner, for both scopes. Present in
                    backend/test/integration/payee-lookup-quota.integration.spec.ts
                    ("has exactly one winner when two claims race over the last
                    slot", "has exactly one winner when two users race over the
                    last slot"). The monthly reset is proven in the same file
                    ("starts the new month at one, however much the previous
                    month spent", both scopes) and the zone by "files the claim
                    under the current Pacific month". Transaction independence
                    -- the claim commits even when its caller is inside a
                    transaction -- is
                    payee-lookup-quota.transaction.spec.ts, because the sibling
                    unit spec mocks that plumbing away.
Status              enforced
```
### INV-BACKUP-001 -- a backup is complete, verified, owner-namespaced

```text
Statement           A backup artifact is namespaced by owner, written completely,
                    and verified before it is reported as done.
Enforcement         Namespacing: userFolderPath uses shardedSegments(userId) for
                    <base>/<ab>/<cd>/<userId>/, because the filenames carry only a
                    tier and a date; browse and validate are admin-gated.
                    Completeness: writeFileAtomic (atomic-file.ts) writes to a temp
                    file, fsyncs, size-checks, then renames and fsyncs the dir, and
                    refuses to publish a short file; promotions use copyFileAtomic
                    with a size check, not copyFileSync. The durable completeness
                    verdict lives inside the document (completeness in the envelope,
                    backup-format.ts, reached from digests) and restore refuses an
                    artifact whose completeness.complete is false. Encrypted
                    artifacts are truncation-authenticated frame-by-frame
                    (backup-envelope.ts). lastBackupStatus reflects the outcome
                    (complete vs partial), not an unconditional success.
Concurrency scope   per user
Crash semantics     A kill or ENOSPC mid-write leaves the temp file, never a
                    truncated final name -- the rename is the publish.
Required tests      Present: atomic-file.spec.ts and auto-backup.service.spec.ts
                    use a real mkdtemp; backup.service.spec.ts asserts restore
                    honours the artifact's own completeness claim.
Status              enforced
```

Encryption is settled and worth not re-litigating: a support backup is
unconditionally encrypted because it exists to leave the user's machine, and an
automatic backup whose stored password cannot be decrypted is *refused* rather
than written in clear.

What was *not* settled, and is the one thing this invariant does not claim: that
an automatic backup is encrypted at all. It is encrypted whenever the server
holds a usable copy of the user's password, and until issue #1269 that copy was
keyed on `AI_ENCRYPTION_KEY` while that variable was optional -- so a deployment
that configured no AI provider wrote plaintext indefinitely, and nothing said so.
The key is `ENCRYPTION_KEY` (`common/encryption/encryption-key.ts`); the former
name is still read. It is not enforced at startup yet -- a deployment without one
boots and is warned, on every start, that backups are unencrypted and that a
future release will refuse to serve -- so the enforcement today is entirely
*visibility*: the boot warning, a warning on every unencrypted automatic backup,
and `getStatus` reporting "this server cannot encrypt" separately from "this user
has not enabled it". Plaintext remains a legitimate outcome for an account with
no captured password, which is why the boot check announces rather than refuses;
when the requirement lands, the unkeyed branch of `logEncryptionKeyStatus`
becomes a throw and this paragraph becomes one sentence.

### INV-CRON-001 -- one logical effect per tick

```text
Statement           A scheduled job produces one logical effect per tick,
                    regardless of replica count.
Enforcement         Per job, and now mostly a durable cross-replica claim.
                    common/jobs/job-claim.service.ts provides claimOnce (INSERT ...
                    ON CONFLICT DO NOTHING RETURNING) and claimLease/markDelivered
                    (at-least-once with a lease token + migration-143 fence). The
                    jobs previously unguarded are guarded: scheduled auto-posting
                    (INV-OCCURRENCE-001, occurrence-key claim), budget rollover
                    (ON CONFLICT (budget_id, period_start) DO NOTHING RETURNING with
                    the loser re-reading the winner), AI insight generation
                    (claimLease, not a process-local Set), demo reset (claimLease).
                    The MNY reaper's conditional CAS and the price/FX refreshes'
                    natural-key ON CONFLICT were already real.
                    Still partial: the account-balance recompute is idempotent
                    against itself and, under INV-BALANCE-001's lock, against a
                    concurrent delta -- but per-job two-instance test coverage is
                    not demonstrably complete across every job.
Concurrency scope   per job, per logical key
Required tests      Two-instance per job. The MNY job has one; the others rely on
                    the claim layer's unit coverage and are still owed theirs.
Status              partial
```

`docs/cron-jobs.md` lists schedules; per section 7 of
`docs/concurrency-and-idempotency.md` it must also record, per job, what prevents
two replicas from producing the same effect.

### INV-PUSH-001 -- a subscription belongs to its caller, and an endpoint to one account

```text
Statement           A push subscription is owned by the authenticated caller; a
                    browser endpoint has exactly one owner; and no request
                    writes to, or deletes, a row belonging to another account.
Source of truth     push_subscriptions.user_id, arbitrated by
                    idx_push_subscriptions_endpoint
Enforcement         Ownership: CreatePushSubscriptionDto has no userId field at
                    all and forbidNonWhitelisted rejects one, so the tenant can
                    only be req.user.id; every list, delete and outcome write
                    carries user_id in its own WHERE. Endpoint exclusivity: the
                    unique index is on endpoint_hash ALONE, not
                    (user_id, endpoint_hash) -- pushManager.subscribe() is scoped
                    to a browser profile and an origin, so two accounts used in
                    one browser receive the same endpoint AND the same encryption
                    keys, and a per-user index would leave both rows live and let
                    the first account's notification be decrypted and displayed on
                    the device the second is now using.
                    The second subscriber is REFUSED, not allowed to take the row
                    over: ON CONFLICT (endpoint_hash) DO UPDATE ... WHERE
                    user_id = EXCLUDED.user_id returns no row when the conflict
                    belongs to somebody else, and that is a 409. The takeover this
                    replaced deleted another tenant's row on the strength of a
                    client-supplied string -- an unauthorized cross-tenant write,
                    and a silent one: the first account lost push with no notice.
                    An endpoint is not proof of ownership, so it buys no right.
Concurrency scope   per endpoint, globally
Retry semantics     Safe: a repeat subscribe from the same browser refreshes the
                    one row rather than adding a device.
Failure response    409, having written nothing. Not a dead end: the client
                    unsubscribes and subscribes again for a fresh endpoint
                    (enablePushOnThisDevice, exactly one retry), and logout
                    releases the endpoint the same way
                    (releaseLocalPushSubscription), so the ordinary
                    shared-browser case never reaches the refusal.
                    Both refusals on the subscribe path -- the channel being off,
                    and a superseded applicationServerKey -- are decided from a
                    read taken INSIDE the transaction that writes. Read outside
                    it, an administrator's rotation committing in the window
                    left a committed row whose 409 said nothing was written:
                    disableStaleSubscriptions cannot retire a row that does not
                    exist yet, so the device was listed live under a key nothing
                    can be delivered under.
                    The CLIENT's half of shared-browser safety is the registered-
                    endpoint marker, which records the OWNER beside the endpoint:
                    localStorage is per origin while a subscription's owner is an
                    account, so an owner-less marker let the second account read
                    the first's subscription as "revoked" and unsubscribe the
                    browser -- revoking push for somebody not even signed in.
                    classifyPushRegistration answers `foreign` there and acts on
                    nothing.
Required tests      push-subscription.service.spec.ts asserts no statement on
                    this path names another user (no DELETE, no `user_id <>`,
                    every statement bound to the caller), that a foreign conflict
                    is a 409, and that both preconditions are read with a
                    transaction already open (recorded, not asserted inside the
                    mock: an expect that throws there arrives as the rejection
                    the test was expecting). push.test.ts covers the client's
                    single retry, the logout release, the marker's owner and the
                    twelve-row classifier truth table including the foreign
                    rows; PushDevicesPanel.test.tsx covers the panel acting on
                    none of them. The database half needs no new
                    spec: the catalog-driven
                    rls-enforcement.integration.spec.ts enumerates the live
                    schema, so push_subscriptions is bucketed as direct by its
                    user_id column and its policy, its ENABLE and its cross-user
                    INSERT rejection are all asserted automatically -- and the
                    harness picks up migration 178 by content marker (it
                    references app_current_user_id).
Status              enforced
```

### INV-PUSH-002 -- the private key stays on the server

```text
Statement           The instance's VAPID private key is never returned by an API
                    and never stored in plaintext.
Source of truth     push_instance_config.vapid_private_key_enc
Enforcement         Storage: PushConfigService.ensureKeyPair refuses to generate a
                    pair at all when EncryptionService is unconfigured, so an
                    instance without ENCRYPTION_KEY has no push rather than a
                    plaintext secret; the operator already learns about the
                    missing key from the weekly ENCRYPTION_KEY_MISSING alert.
                    Exposure: no response shape in src/push/ declares a private
                    field, and push-secret.guard.spec.ts scans the whole of src/
                    for a second reader of the column, a second caller of
                    getVapidIdentity, a second importer of web-push and a second
                    caller of sendNotification. The public half is public by
                    construction -- every subscribing browser is handed it.
Concurrency scope   per instance
Crash semantics     A pair this instance cannot decrypt (ENCRYPTION_KEY changed
                    under a live database) yields a null identity and a named log
                    line, not an AES-GCM failure behind a generic 500.
Required tests      push-config.service.spec.ts, push-secret.guard.spec.ts.
Status              enforced
```

### INV-PUSH-006 -- a channel is offered only while its key can be used

```text
Statement           Push reports itself available only while this server can
                    actually sign with the stored key pair.
Source of truth     Whether EncryptionService can decrypt
                    push_instance_config.vapid_private_key_enc, resolved once
                    per key pair by PushConfigService.resolveIdentity.
Enforcement         resolveIdentity is the single answer: canUseKeyPair gates
                    `enabled` on both the public and the admin shape, and
                    getVapidIdentity returns what it resolved, so the three
                    cannot disagree. It is memoised on the ciphertext -- key
                    derivation is scryptSync, tens of milliseconds, and this
                    answer is wanted on every config read, subscribe and send --
                    which a rotation invalidates by construction. The failure
                    is otherwise entirely silent: ENCRYPTION_KEY changes under a
                    live database (or a backup lands on another instance), the
                    column stays populated, every "is push configured?" check
                    says yes, and only the send fails -- the same shape
                    AiService names for a stored API key it cannot decrypt.
                    `keyUnreadable` is its own field rather than folded into
                    `configured` because the repairs differ: no key pair is
                    fixed by setting ENCRYPTION_KEY and restarting, an unreadable
                    one by rotating. Two causes, two repairs, one message each.
                    Rotation itself refuses with a 400 when there is nowhere safe
                    to store the new private half, rather than returning the
                    unchanged config -- which reported a refusal as a success,
                    indistinguishable from a genuine no-op rotation.
Concurrency scope   per instance
Failure response    The channel reads as unavailable everywhere, the admin page
                    names the cause and keeps rotation offered, and the account
                    surface stops offering an enable button that would produce a
                    subscription nothing is ever delivered to.
Required tests      push-config.service.spec.ts (both surfaces report the
                    unreadable pair, it stays distinct from having none, and the
                    rotation refusal throws); the admin page spec asserts the
                    two messages do not collapse into one.
Status              enforced
```

### INV-PUSH-003 -- a rotation retires what it supersedes

```text
Statement           After a key rotation, no subscription minted under the
                    superseded pair is listed as reachable.
Source of truth     push_subscriptions.vapid_public_key vs
                    push_instance_config.vapid_public_key
Enforcement         PushConfigService.rotateKeyPair writes the new pair and sets
                    disabled_at/disabled_reason = KEY_ROTATED on every live
                    subscription carrying a different key in ONE withScopedDb
                    transaction: the push service validates the signature against
                    the key the subscription was created with, so a new pair with
                    live old subscriptions is an interface listing devices it
                    cannot reach. WebPushSender re-checks the stored key before
                    every send, so an interrupted rotation cannot produce an
                    endless stream of 403s either.
Concurrency scope   per instance
Retry semantics     Re-running a rotation mints another pair and retires again;
                    idempotent in effect, not in identity.
Failure response    The count of retired devices is part of the response and of
                    the confirmation dialog, not a log line.
Required tests      push-config.service.spec.ts asserts both writes share one
                    transaction (by transaction identity, not call count);
                    web-push-sender.service.spec.ts asserts the pre-send check.
Status              enforced
```

### INV-PUSH-004 -- a push failure is reported, never raised

```text
Statement           A delivery failure does not roll back the operation that
                    produced the notification, and a subscription that cannot be
                    delivered to stops being attempted.
Source of truth     the PushSendOutcome returned by WebPushSender;
                    push_subscriptions.failure_count / disabled_at
Enforcement         WebPushSender never throws: every transport error is
                    classified and returned. Sends happen outside any
                    transaction, after the reads that selected the targets, and
                    each outcome is written in its own short transaction --
                    the ordering rule of docs/external-side-effects.md section
                    4a. 404 and 410 retire the device immediately (GONE);
                    everything else is transient and bounded by
                    MAX_CONSECUTIVE_FAILURES (FAILING), because retiring on 401
                    or 403 would empty every device list in the deployment over
                    one bad key or clock.
Concurrency scope   per subscription
Retry semantics     A success resets failure_count; the bound is on consecutive
                    failures, not on lifetime attempts.
Crash semantics     A crash between the send and the outcome write loses that
                    attempt's bookkeeping, not the notification. There is no
                    delivery ledger yet -- see docs/external-side-effects.md.
Required tests      web-push-sender.service.spec.ts (the full status table, and
                    that a bare non-Error rejection still resolves);
                    push-subscription.service.spec.ts (per-device outcomes are
                    reported rather than thrown).
Status              enforced
```

### INV-PUSH-005 -- a subscription is instance-bound, not portable

```text
Statement           A backup neither exports nor restores push subscriptions or
                    the instance key pair.
Source of truth     INTENTIONALLY_EXCLUDED_TABLES in
                    backend/src/backup/export-table-queries.ts
Enforcement         Both push tables are listed there, and neither appears in
                    RESTORE_PLAN. The failure being designed against is concrete:
                    a production backup restored into a test instance would hand
                    that instance the endpoints and keys needed to push to real
                    phones. Devices re-subscribe, which costs one click and is
                    the only way the new instance obtains a subscription the push
                    service will accept under its own VAPID key.
                    push_subscriptions.vapid_public_key is the second line of
                    defence: a row that did arrive by some other route carries a
                    key this instance does not hold and is skipped by the sender.
Concurrency scope   per instance
Required tests      The backup integration spec's coverage check fails on a
                    schema table that is in neither the export queries nor the
                    exclusion set, so a future migration cannot quietly start
                    exporting these.
Status              enforced
```

## Platform

### INV-PROVIDER-001 -- an unreachable provider stops being called, and is reported once

```text
Statement           A provider that stops answering stops being called: after
                    five transport failures inside a five-minute window no
                    request leaves the process until a single timed probe is
                    admitted. One outage
                    episode produces at most one alert email and one all-clear,
                    across replicas and across restarts.
Source of truth     The per-process ProviderCircuit decides whether to call out;
                    provider_health decides what has been said about it.
Enforcement         Not calling: ProviderCircuit's threshold over a sliding
                    time window (a consecutive run is not countable against a
                    provider that answers headers and stalls bodies), plus an
                    exclusive
                    half-open probe slot (bounded by PROBE_TIMEOUT_MS so a caller
                    that never reports cannot hold it for the life of the
                    process); assertAvailable runs before the concurrency gate,
                    so a refusal costs no socket. Reporting once: a single
                    conditional UPDATE on provider_health claims the notice
                    (state = 'down' AND outage_notified_at IS NULL AND
                    outage_started_at <= now() - 15min AND (last_notified_at IS
                    NULL OR last_notified_at <= now() - 6h) RETURNING), so the
                    claim is the serialization point rather than a read followed
                    by a write. The upsert preserves outage_started_at while the
                    stored state is 'down', which is what makes the 15-minute
                    gate survive the restart loop an outage provokes. Log volume:
                    ProviderHealthService.logFailure is rate-limited per provider
                    and silent for a refused call.
Concurrency scope   provider key (breaker: per process; notification: global)
Retry semantics     Refusals and successes are idempotent. A recovery clears the
                    episode marker, and last_notified_at is never cleared, so a
                    flapping provider cannot mail a pair per flap.
Crash semantics     The alert is at most once: the claim commits before SMTP is
                    called, so a process killed in between loses that notice --
                    deliberate for a monitoring email (the duplicate is the
                    failure mode being designed against), and the provider
                    becomes notifiable again once the 6-hour floor elapses. The
                    breaker's own state is process-local by design and resets on
                    restart; the durable episode start is what stops that reset
                    from re-arming the alert.
Failure response    ProviderUnavailableError to the caller, which every provider
                    client turns into its usual null/empty result -- an outage
                    leaves data unpriced, never a failed user request.
Required tests      Present: provider-circuit.spec.ts, provider-health.service
                    .spec.ts, provider-outage-alert.service.spec.ts,
                    provider-call.guard.spec.ts, the end-to-end pair in
                    yahoo-finance.service.spec.ts, and -- for the two properties
                    that live in SQL rather than in TypeScript --
                    test/integration/provider-health.integration.spec.ts against
                    a real PostgreSQL: the upsert's CASE preserving
                    `outage_started_at` across a restart, and three concurrent
                    sweeps producing exactly one email. That spec is what caught
                    the claim being read as `result[0]` when the driver returns
                    `[rows, rowCount]` for an UPDATE -- every unit test passed
                    against a mock that returned the flat shape, and in
                    production the send threw with the claim already committed.
                    Owed: nothing exercises two *processes*, so the exclusion is
                    proven across concurrent transactions rather than across
                    replicas.
Status              enforced
```

### INV-ALERT-001 -- a system alert is raised once, and only the insert winner emails

```text
Statement           A system-level alert (BACKUP_FAILED, ENCRYPTION_KEY_MISSING,
                    PROVIDER_OUTAGE, SMTP_FAILURE, SCHEDULED_POST_FAILED, ...)
                    is materialized at most once per (recipient, dedupe key)
                    however many replicas raise it, and its admin email is sent
                    only by whichever replica's INSERT actually created the row.
                    SMTP_FAILURE never emails at all.
Source of truth     notifications.dedupe_key under the partial unique index
                    idx_notifications_dedupe (user_id, dedupe_key) WHERE
                    dedupe_key IS NOT NULL (migration 170). The fingerprint
                    index from migration 140 cannot arbitrate these rows: it
                    keys on budget_id, NULL for every system alert, and NULL
                    never equals NULL in a unique index.
Enforcement         SystemAlertService.insertAlert asks
                    NotificationService.create, whose INSERT ... ON CONFLICT DO
                    NOTHING RETURNING id names no conflict target and so is
                    arbitrated for these rows by the dedupe index; the email leg
                    runs only where create returned a row. shouldEmail refuses
                    SMTP_FAILURE unconditionally.
                    The provider pair additionally sits behind provider_health's
                    conditional-UPDATE claim, so its episode semantics are
                    unchanged.
Concurrency scope   (user_id, dedupe_key)
Retry semantics     Raising the same alert again inside its dedupe bucket is an
                    idempotent no-op; the next bucket (day, week, or episode)
                    raises it afresh while the condition persists. The 30-day
                    purge frees the key, so a standing condition re-alerts --
                    intended, see docs/specs/system-alerts.md.
Crash semantics     The email is at most once: a process killed between the
                    insert committing and SMTP accepting loses that email; the
                    in-app row survives as the durable notice. Same trade as
                    INV-PROVIDER-001, same reason.
Failure response    raiseAdminAlert/raiseUserAlert never throw -- an alert is a
                    side reporting channel, and its failure is logged and
                    swallowed so it cannot end the sweep that noticed the
                    original problem.
Required tests      system-alerts/system-alert.service.spec.ts (fan-out,
                    insert-loser sends no email, SMTP_FAILURE never emails,
                    never throws); test/integration/system-alert-dedupe
                    .integration.spec.ts against a real PostgreSQL (concurrent
                    same-key raises produce one row per admin; the partial-index
                    ON CONFLICT target is accepted by the real planner, which a
                    mocked query cannot prove).
Status              enforced
```

### INV-NOTIFY-001 -- one writer owns the notifications table

```text
Statement           Every notification a PRODUCER creates is written by
                    NotificationService.create, so the column bounds, the
                    conflict handling and the period_start default are one rule
                    rather than one rule per producer. The backup restore is the
                    one exception, and it is not covered (see Status).
Source of truth     src/notification-center/notification.service.ts
Enforcement         notification-write-door.spec.ts scans every tracked
                    non-spec file under backend/src for a raw INSERT/UPDATE/
                    DELETE naming the table and for a repository write on the
                    Notification entity, with comments blanked so the prose
                    explaining the ban cannot trip it. Three files are
                    allowlisted with reasons -- the door, delete-my-data, and
                    the restore -- and the spec also fails if an allowlisted
                    file stops writing, because a standing permission nobody
                    uses is inherited by the next writer in that file.
                    What the scan CANNOT see: backup-restore-database.service.ts
                    inserts through a dynamic table name
                    (`INSERT INTO "${table}"`, driven by RESTORE_PLAN, whose
                    notifications entry this branch added), so a restored row
                    never passes boundedTitle, boundedDedupeKey or
                    boundedTarget. The one field where that has a consequence a
                    reader can see is `target`, and it is re-validated at the
                    consumer instead: safeNotificationTarget resolves it against
                    this origin before any navigation, on the app side and again
                    in the service worker. The column widths are the database's
                    own (a longer value raises 22001 and fails the restore
                    loudly, which is the honest failure for an artifact that
                    does not fit).
Concurrency scope   n/a -- a static property of the source
Retry semantics     n/a
Crash semantics     n/a
Failure response    n/a
Required tests      notification-write-door.spec.ts (the scan, plus a
                    stripper test in both directions);
                    notification.service.spec.ts (the bounds and the conflict
                    answer the door enforces on every producer's behalf).
Why it exists       There were three writers with three opinions: a raw INSERT
                    for budget alerts with its own conflict target and no title
                    bound, an entity save for bill reminders with no conflict
                    handling at all, and a second raw INSERT for system alerts
                    with its own truncation helpers. Every rule the row has to
                    obey therefore held on one path and not the others -- an
                    over-long scheduled-transaction name raised 22001 inside a
                    never-throws catch, and the notification the user needed
                    silently never existed.
Status              partial -- every producer goes through the door and the scan
                    proves it, but the restore's dynamic-table insert is outside
                    what a source scan on the table name can reach. Closing it
                    means the restore calling the door per row (which would
                    rewrite ids and conflict handling the restore owns) or the
                    scan understanding RESTORE_PLAN; neither is done, so this
                    entry says so rather than claiming a coverage it does not
                    have.
```

### INV-PUSH-007 -- UnifiedPush rides the one Web Push sender

```text
Statement           A UnifiedPush subscription is a Web Push subscription (an
                    endpoint at a distributor plus the RFC 8291 keys, signed
                    under this instance's VAPID pair), so it is delivered by
                    WebPushSender and nothing else; no second transport importer
                    exists in src/.
Source of truth     src/push/web-push-sender.service.ts (the only importer of
                    `web-push`); docs/specs/notification-preferences.md §15.
Enforcement         push-secret.guard.spec.ts scans src/ for a second `web-push`
                    importer or `sendNotification` caller and fails on one.
Concurrency scope   n/a -- a static property of the source
Failure response    n/a
Required tests      push-secret.guard.spec.ts
Why it exists       Delivery isolation (discussion #1291): a business feature asks
                    for a notification and never imports a transport, so a new
                    wire arrives without any producer changing -- and a second
                    sender would be a second place the private key is handed to.
Status              enforced
```

### INV-PUSH-008 -- a transport gates its own wire's devices

```text
Statement           The per-category `push` toggle reaches web-push devices only
                    and `unifiedpush` reaches UnifiedPush devices only. A user
                    with `push` on and `unifiedpush` off is never delivered to
                    on a distributor endpoint, and the reverse.
Source of truth     push_subscriptions.transport (migration 184), read by
                    PushSubscriptionService.sendToUser's transport filter;
                    NotificationDispatchService.fanOut builds the set from
                    resolveNotificationDelivery.
Enforcement         Two halves, each tested: the dispatch passes exactly the
                    enabled set (notification-dispatch.service.spec.ts, the
                    four-combination matrix) and the service applies it as
                    `transport IN (...)` on the device query, with an empty set
                    reaching no database at all
                    (push-subscription.service.spec.ts). `sendTest` deliberately
                    passes no filter: a test send asks whether ANY device works.
Concurrency scope   per user, per notification
Failure response    A device on a wire the user gated off is never queried, so
                    there is nothing to fail.
Required tests      notification-dispatch.service.spec.ts (the set);
                    push-subscription.service.spec.ts (the filter, the empty set,
                    the stored transport on subscribe).
Why it exists       The two channels ride one encrypted wire and differ only by
                    which devices they reach -- so the FILTER is the consent
                    boundary. Without a service-layer test the first revision of
                    §15 shipped with the filter undetected by any mutation.
Status              enforced
```

### INV-PUSH-009 -- an unsupported channel is forced off at resolution

```text
Statement           A channel a matrix category does not expose
                    (NOTIFICATION_CATEGORY_CHANNELS) resolves to OFF in
                    resolveNotificationDelivery whatever the stored row holds,
                    so a value written to an unsupported cell can never become a
                    delivery nobody asked for.
Source of truth     NOTIFICATION_CATEGORY_CHANNELS in
                    notification-preference.service.ts, mirrored on the client
                    and returned per row as `supportedChannels`.
Enforcement         resolveNotificationDelivery ANDs every channel with its
                    support flag; notification-preference.service.spec.ts proves
                    SYSTEM's email stays off with the master switch on and a
                    stored `true`; notification-preferences.contract.test.ts
                    holds the client mirror equal, reading every channel the
                    backend declares rather than a fixed list.
Concurrency scope   n/a
Failure response    n/a
Required tests      notification-preference.service.spec.ts;
                    notification-preferences.contract.test.ts.
Why it exists       SYSTEM exposes push only -- its email is the admin fan-out's
                    own severity-driven path -- and a cell that renders "not
                    applicable" must also be one whose stored value is inert.
Status              enforced
```

### INV-PUSH-010 -- a UnifiedPush endpoint is a server-outbound URL, bounded to one transport list

```text
Statement           A distributor endpoint is validated exactly as a browser
                    endpoint is (IsPushEndpoint: https floor + SSRF resolve
                    bounded inside the check), and `transport` is bounded to
                    PUSH_TRANSPORTS -- one list held equal across the DTO, the
                    CHECK constraint and the client union.
Source of truth     src/push/dto/create-push-subscription.dto.ts (`@IsIn`);
                    push_subscriptions_transport_check in database/schema.sql
                    and migration 184; PUSH_TRANSPORTS in the entity and in
                    frontend/src/lib/push.ts.
Enforcement         The one controller line that registers a subscription passes
                    the validated DTO; push-transport.contract.spec.ts holds the
                    constant equal to the CHECK's literal set and the default,
                    and push-transport.contract.test.ts (frontend) holds the
                    client array equal to the entity's.
Concurrency scope   n/a
Failure response    A transport outside the list is refused by the DTO before
                    any write; a drift between the copies fails the contract
                    tests rather than surfacing as a 23514 the subscriber sees
                    as a generic 500.
Required tests      push-endpoint validator specs (unchanged);
                    push-transport.contract.spec.ts;
                    push-transport.contract.test.ts.
Why it exists       An endpoint is a URL the server will POST to (CWE-918), and
                    a list that means something is written once in the place
                    that can check it.
Status              enforced
```

### INV-DISPATCH-001 -- the dispatch seam never writes a row

```text
Statement           NotificationDispatchService.notify writes nothing itself; it
                    calls NotificationService.create and fans out from what the
                    door returned.
Source of truth     src/notifications/notification-dispatch.service.ts
Enforcement         notification-write-door.spec.ts (the scan admits no writer
                    but the door); notification-dispatch.service.spec.ts asserts
                    `create` is what is called with the producer's input.
Concurrency scope   n/a
Failure response    n/a
Required tests      notification-write-door.spec.ts;
                    notification-dispatch.service.spec.ts.
Status              enforced
```

### INV-DISPATCH-002 -- the in-app row is always written

```text
Statement           Every `notify` writes the bell row regardless of the matrix
                    or the throttle: a category with push and email both off
                    still bells, and a throttled fan-out still leaves the row.
Source of truth     notify: `create` runs before, and independently of, fanOut.
Enforcement         notification-dispatch.service.spec.ts ("always writes the
                    in-app row even with push and email both off").
Concurrency scope   per notification
Failure response    The row stands; only the fan-out is skipped.
Required tests      notification-dispatch.service.spec.ts.
Why it exists       The maintainer's ruling (spec §3/§4): the bell is the record;
                    a first throttle draft dropped the row and was reverted.
Status              enforced
```

### INV-DISPATCH-003 -- the throttle gates the fan-out only, and never an escalation

```text
Statement           A per-category cooldown suppresses only notification-mode
                    push/email; never the in-app row, never a report email, and
                    never a notification whose severity strictly exceeds every
                    prior in the window.
Source of truth     NotificationDispatchService.notify: when the throttle is
                    active, pg_advisory_xact_lock(notif-fanout:<user>:<category>)
                    is taken BEFORE the row is written, and priorInWindow decides
                    on the same manager, in the same transaction.
Enforcement         The lock is held across the write and the decision, so the
                    later of two same-category deciders on different replicas
                    blocks until the earlier row is committed and then sees it
                    (D7). Taken after the commit -- the first version -- it
                    serialised nothing: B could commit and decide before A's row
                    was visible, and A then decided against B's later created_at.
                    "Prior" is every other live same-category row in the
                    window, excluded by id -- never by created_at ordering,
                    which is the transaction's BEGIN time and can put the later
                    lock-holder's row first. The decision precedes the caller's
                    onWritten follow-up. A reminder's re-emit (data.reminderId)
                    sits outside the cooldown on both sides: it takes no lock and
                    no decision, and it is never a prior for anything else --
                    the cooldown governs producers, not the user's own schedule.
                    The EXISTS query carries severitiesAtOrAbove so an
                    escalation never matches.
                    notification-dispatch.service.spec.ts holds the lock -> write
                    -> decide -> hook order, the id exclusion, the lock on both
                    the push and the email path, the window-0 short-circuit, and
                    the escalation set.
Concurrency scope   per (user, category), across replicas
Failure response    A suppressed fan-out is a skipped send; the row is already
                    committed.
Required tests      notification-dispatch.service.spec.ts.
Status              enforced
```

### INV-DISPATCH-004 -- a delivery failure never reaches the producer

```text
Statement           A failed push or email neither rolls back nor surfaces
                    through the notification it is about: `notify` resolves with
                    the committed row and logs the failure, whether the caller
                    awaited the fan-out or detached it.
Source of truth     notify's `.catch` on the fan-out promise;
                    PushSubscriptionService.sendToUser is non-throwing.
Enforcement         notification-dispatch.service.spec.ts ("never lets a fan-out
                    failure escape", and the detached-mode failure case).
                    The row is committed by `create` before any fan-out runs, so
                    there is nothing a rollback could reach.
Concurrency scope   per notification
Failure response    Logged once with the row id; the bell row stands.
Required tests      notification-dispatch.service.spec.ts.
Why it exists       A read-path producer (bill reminders on GET /notifications)
                    detaches the fan-out so a stalled push endpoint cannot hold
                    the reader; the guarantee has to hold on that path exactly
                    as on the awaited one.
Status              enforced
```

### INV-RLS-001 -- enforced mode refuses a privileged role

```text
Statement           Under RLS_MODE=enforce the application refuses to serve
                    traffic on a role that can bypass row-level security --
                    including membership reachable via SET ROLE, not only the
                    role's own attributes.
Enforcement         A single classifier refuses a privileged role at startup.
                    common/db/runtime-role-check.ts (assertRuntimeRoleSafe) reads
                    pg_roles for rolsuper/rolbypassrls/rolreplication/rolcreaterole/
                    rolcreatedb, database ownership, owned policied tables,
                    SET ROLE-reachable exempt contexts, inherited owner roles and
                    forbidden predefined-role memberships (pg_has_role, transitive).
                    Wired at both call sites: main.ts about its own connection
                    (process exit on violation -- "refuse to boot") and db-init.ts
                    about the configured role by name (assertRuntimeRoleSafeByName).
Concurrency scope   global, at startup
Failure response    Refuse to boot.
Required tests      Present: runtime-role-check.spec.ts (unit, incl. superuser,
                    BYPASSRLS and inherited-membership cases) and a live-catalog
                    integration spec.
Status              enforced
```

This is the backstop for the entire RLS design: if enforced mode is switched on
with a misconfigured role, startup now refuses rather than serving silently. Two
adjacent items are their own concerns, not this invariant's: delegation's
cross-user lookups (a candidate below) and whether `db-init` / `db-migrate` are
serialized across replicas -- `common/db/advisory-locks.ts` now exists and that
sub-point warrants its own re-check.

### INV-CACHE-001 -- a money-moving write invalidates its caches

```text
Statement           A write that changes money invalidates every client cache
                    family derived from transactions.
Enforcement         invalidateBalanceCaches (frontend lib/apiCache.ts) drops the
                    accounts:, investments: AND budgets: prefixes -- every
                    transaction-derived family. The cache layer is frontend, which
                    is why the function name does not appear in backend/src.
Concurrency scope   per browser tab
Failure response    a saved transaction drops the budget cache, so the progress
                    bar reflects the write.
Required tests      Present: frontend cache-prefix-classification.guard.test.ts
                    requires every cache prefix to declare itself transaction-
                    derived (and be dropped) or reference-data (and be kept), so a
                    new family cannot default to stale; balance-cache.guard.test.ts
                    requires every balance-writing API method to invalidate.
Status              enforced
```

### INV-RELEASE-001 -- one revision

```text
Statement           The tested commit, the published image's revision, the pushed
                    release commit and the release tag identify one source
                    revision, or a later full gate verifies the final revision.
Source of truth     the git commit SHA
Enforcement         Partial. The image half is right: prepare-release resolves
                    the SHA once in a job that creates no commit and threads it
                    into the build arg and the OCI revision annotation, and
                    cosign, the SBOM attestation and the Trivy gate all target
                    the digest. The git half is not: the release job pushes a
                    "[skip ci]" version-bump commit to protected main with an
                    admin PAT, nothing re-runs the gate on it, and gh release
                    create with no --target tags the branch tip.
Concurrency scope   global -- one release at a time, not currently enforced
Retry semantics     A re-run after a partial release may bump the version twice;
                    nothing detects an already-published version.
Crash semantics     A failure between the image push and the version-bump commit
                    leaves a published image no tag refers to.
Failure response    Refuse to tag rather than tag an unverified revision.
Required tests      A workflow self-test asserting the bump commit's parent is the
                    tested SHA and its diff touches only version manifests.
Status              partial
```

`docs/release-integrity.md` has the full rules and gap register, including
REL-001's blanket pass-with-no-tests rule and what still remains unenforced
under REL-002.

### INV-MIGRATION-001 -- numeric prefix order, and a prefix that cannot collide

```text
Statement           Every place that orders database/migrations/*.sql orders
                    them by the NUMERIC value of the filename prefix, then by
                    the full filename; and a migration added after 2026-09-05
                    carries a YYYYMMDDHHMMSS_ prefix (the UTC second of
                    authoring), so two authors working in parallel cannot
                    produce the same prefix. The NNN_ files are historical:
                    never renumbered, never added to.
Source of truth     The filename. schema_migrations keys on it, so a rename is
                    a migration no database has recorded.
Enforcement         backend/src/common/db/migration-filename.ts is the one
                    definition of the prefix grammar and the comparator; the
                    runner (db-migrate.ts), the integration harnesses
                    (rls-setup.ts, migration-path.integration.spec.ts,
                    migration-table-renames.spec.ts), the migration lint and
                    scripts/check-migration-prefixes.mjs import it (the two
                    .mjs scripts through Node type stripping);
                    scripts/verify-schema.sh reproduces it with `sort -n` and
                    migration-filename.spec.ts runs that pipeline against the
                    comparator. The same spec fails a bare .sort() over a
                    migrations listing anywhere under backend/ or scripts/, and
                    holds LEGACY_PREFIX_CEILING equal to the directory's real
                    maximum in both directions. check-migration-prefixes.mjs
                    (Documentation vs Manifests job) refuses a duplicate prefix
                    outside the six grandfathered pairs, a new NNN_ file (by
                    ceiling with no git, by base comparison with it), a
                    timestamp that is not a real UTC instant between adoption
                    and now, and a base-branch migration gone missing.
Concurrency scope   global (one directory, every branch)
Retry semantics     n/a
Crash semantics     n/a
Failure response    db-migrate refuses to start on a filename it cannot order;
                    CI fails on any of the check's findings.
Required tests      migration-filename.spec.ts (unit, fixture the string sort
                    gets wrong, shell equivalence, directory, source scan);
                    db-migrate.spec.ts (runner applies the mixed-width fixture
                    in numeric order and refuses an unparseable name).
Why it exists       Prefixes collided eight times under the counter (022, 068,
                    075, 116, 117, 124, then 165 and 166 within nine hours)
                    because two branches read the same maximum; and the
                    runner's readdirSync(...).sort() was a string sort, correct
                    only by the coincidence that every historical prefix begins
                    with 0 or 1 and every timestamp with 2 (issue #1277).
Status              enforced
```

What this does NOT claim: that apply order equals merge order. Prefixes are
assigned at authoring time under both schemes, so a migration merged later can
carry an earlier prefix and replay first on a fresh install. A migration must
not depend on the ordering of another in-flight migration; nothing checks that
beyond review.

## Candidates not yet admitted

These were raised while assembling the catalog and are **not** entries, because
each needs a direct reading of the source before it can be stated as an
invariant. They are listed so the work is not lost and so nobody re-derives them
from scratch; an unverified entry above the line would undermine every verified
one.

| Candidate | What to check |
| --- | --- |
| Delegation's cross-user lookups run in the caller's tenant scope | `delegation.service.ts` uses plain `withScopedDb` throughout, including `mayManageCredentials`. Inert at `RLS_MODE=off`; under `enforce` a cross-user count would see only the caller's rows. Confirm what each lookup needs before writing the rule. |
| An export must read every table from one snapshot | Whether `backup.service.ts`'s export methods share a transaction, and whether `REPEATABLE READ` is required for a self-consistent artifact. |
| Restore must handle self-referential FKs by insertion order | `accounts.linked_loan_account_id` and whether the strip/repair lists are hand-maintained and therefore drift-prone. |
| `record()` must not run inside an ambient transaction | Whether a failed action-history insert can abort a caller's write, and at what log level a lost undo entry surfaces. |
| Bootstrap must be serialized across replicas | `db-init` and `db-migrate` have no advisory lock; each pod decides from its own read of `schema_migrations`. The absence is confirmed; the required behaviour is not yet specified. |

## Using this catalog

**In a pull request.** Name the invariant IDs the change touches. If it moves one
from `unenforced` to `enforced`, update the entry in the same commit and delete
the citation of the violation -- an entry describing a violation that no longer
exists is worse than no entry, because it will be read and believed.

**In a review.** An entry marked `enforced` names its mechanism; check the change
does not remove it. INV-AUTH-001 is the live example -- correct today, and correct
by a lock whose purpose is not obvious from the call site.

**When adding an invariant.** It belongs here if it is cross-layer. A rule that
one service can enforce alone belongs in that service, or in a type, or in a lint
rule -- per root `CLAUDE.md`, prefer the highest enforcement the mistake allows,
and use prose only for the part that genuinely needs judgement. This document is
prose, which makes it the weakest of the available options and the one most in
need of the machine-checkable rules the entries above call for.
