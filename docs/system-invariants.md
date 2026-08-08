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
guessing -- see INV-AUTH-004.

## Index

| ID | Invariant | Status |
| --- | --- | --- |
| INV-IMPORT-001 | At most one pending or running MNY import per user | enforced |
| INV-IMPORT-002 | A retry never double-imports | unenforced |
| INV-IMPORT-003 | A category collision does not abort an import | unenforced |
| INV-BALANCE-001 | `current_balance` equals opening balance plus included ledger rows | unenforced |
| INV-HOLDING-001 | A holding equals a deterministic replay of the investment ledger | unenforced |
| INV-HOLDING-002 | Every view replays the ledger the same way | unenforced |
| INV-TRANSFER-001 | A transfer's two legs share one status and one balance decision | unenforced |
| INV-FX-001 | An unavailable rate never becomes 1:1 | unenforced |
| INV-OCCURRENCE-001 | One scheduled occurrence has at most one financial effect | unenforced |
| INV-OCCURRENCE-002 | A stored override price survives reopening | unenforced |
| INV-CLAIM-001 | An emergency-access claim token is consumed exactly once | unenforced |
| INV-AUTH-001 | A refresh token rotates once, or the family is revoked | enforced |
| INV-AUTH-002 | A failed-login counter records every failure | unenforced |
| INV-AUTH-003 | A destructive OIDC action requires a provider round trip | unenforced |
| INV-AUTH-004 | A logout reports only what it achieved | partial |
| INV-ACTIVITY-001 | Activity is attributed to whoever acted, not to whoever was acted for | unenforced |
| INV-PROFILE-001 | A user-profile response is an allowlist | unenforced |
| INV-MCP-001 | An MCP session is bound to the credential that opened it | unenforced |
| INV-CURRENCY-001 | A shared currency is deleted only by its creator, on a global count | unenforced |
| INV-ATTACHMENT-001 | Available metadata resolves to committed bytes | partial |
| INV-BACKUP-001 | A backup file is complete, verified and owner-namespaced | partial |
| INV-CRON-001 | One logical cron effect per schedule tick, across replicas | partial |
| INV-RLS-001 | Enforced mode refuses to run on a role that can bypass RLS | unenforced |
| INV-CACHE-001 | A money-moving write invalidates every derived cache | unenforced |
| INV-RELEASE-001 | The tested, imaged and tagged revisions are one revision | partial |

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
Source of truth     the staged file bytes; import_jobs.status
Enforcement         None once the business data has committed. writeAll opens its
                    own withScopedDb transaction and commits when it returns;
                    post-processing, verification, holdings verification, staged-
                    file deletion and the terminal status update all run after
                    that commit. No durable data-committed checkpoint, import-run
                    identifier, or deterministic per-source-record key exists, and
                    each parse pre-generates fresh row UUIDs, so nothing
                    downstream can recognise a row as already imported.
Concurrency scope   per user
Retry semantics     Safe when the failure occurred inside writeAll -- nothing
                    committed. Unsafe when the failure occurred after writeAll
                    committed, or when the commit result is unknown.
Crash semantics     A crash between writeAll's commit and terminal completion
                    leaves committed accounts, transactions, investments and
                    prices behind a job that is running or failed-retryable. The
                    reaper marks it retryable, which is correct for the job row
                    and wrong for the data.
Failure response    A retry must reconcile: finalize the committed run rather than
                    replay it, or refuse until the run's state is known.
Required tests      Failpoint: commit writeAll, then fail before terminal
                    completion, retry, and assert every imported row exists
                    exactly once. A test that throws inside the import
                    transaction does not reach this window. No such test exists.
Status              unenforced
```

Worth spelling out how this looked correct. The source comment above `runImport`
says "The whole write is one transaction, so a failure leaves nothing behind and
Retry cannot double-import." The first clause is true of `writeAll`. The second
does not follow from it, because the import is not finished when `writeAll`
commits -- and the comment's scope ("the whole write") is what makes the
inference look sound. The numbers:

```text
Source file transaction:   -25.00
First attempt commits:     -25.00   writeAll returns, then the worker dies
Retry re-parses, commits:  -25.00   fresh UUIDs, nothing recognises the first copy
Resulting effect:          -50.00
Expected effect:           -25.00
```

This entry was itself marked `enforced` in an earlier revision of this document,
on the strength of that comment. It is the catalog's own cautionary tale: a
status copied from a comment is not a verified status, and CONC-007 exists
because the mechanism named has to cover the scope claimed. The mechanisms that
would close it are a `data_committed` checkpoint written in the same transaction
as the rows, a stable import-run id carried by every imported record, or a
recovery path that finalizes rather than replays.

Note also that a "start fresh" wipe is applied in `start`, outside the job body,
so it does not make a retry idempotent: an append-mode import that committed and
then failed has no wipe to save it.

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
Enforcement         None across writers. Three incompatible protocols coexist on
                    one column:
                      - atomic delta: updateBalance's
                        SET current_balance = ROUND(... + $1, 4)
                      - unlocked absolute recompute: recalculateCurrentBalance,
                        the hourly applyDueTransactionBalances,
                        import-post-processing, write-transactions,
                        action-history.recalculateBalance
                      - pessimistically locked read-then-write: accounts update,
                        accounts close
                    A delta committing between a recompute's SELECT and its
                    UPDATE is silently discarded.
Concurrency scope   per account
Retry semantics     A recompute is idempotent against another recompute and not
                    against a concurrent delta.
Failure response    Currently silent divergence -- the worst available.
Required tests      Two-connection: delta interleaved with recompute, asserting
                    the delta survives. No such test exists.
Status              unenforced
```

See `docs/concurrency-and-idempotency.md` CONC-003. Also breached by transfers
created as `VOID`, which update both balances regardless of status.

### INV-HOLDING-001 -- a holding is a deterministic ledger replay

```text
Statement           holdings.quantity and average_cost equal a deterministic
                    replay of that account's investment ledger.
Source of truth     investment_transactions
Enforcement         None. Every mutation path (createOrUpdate, updateHolding,
                    applySplit, reverseSplit, adjustQuantity) is a JavaScript
                    read-modify-write inside a transaction with no lock and no
                    atomic delta. UNIQUE(account_id, security_id) prevents
                    duplicate rows and does nothing about a lost update to one.
Concurrency scope   per (account, security)
Retry semantics     Not idempotent; a lost update is invisible.
Failure response    Silent divergence from the ledger.
Required tests      Two-connection: concurrent trades on one holding, replay
                    compared against the stored row.
Status              unenforced
```

### INV-HOLDING-002 -- every view replays the ledger the same way

```text
Statement           Every surface that derives a share count from the investment
                    ledger must apply each action identically.
Source of truth     one shared reducer, which does not currently exist
Enforcement         None, and the paths actively disagree:
                      - holdings.service.ts multiplies on SPLIT
                        (qty *= txQty; next = current * quantity) and handles
                        ADD_SHARES/REMOVE_SHARES
                      - net-worth.service.ts adds on SPLIT at all three of its
                        reducers, groups SPLIT with BUY/REINVEST/TRANSFER_IN at
                        one of them, and handles no ADD_SHARES/REMOVE_SHARES at all
Concurrency scope   --
Failure response    The holdings page and every historical net-worth chart report
                    different share counts for the same position after any split.
Required tests      A source-scanning guard failing on any SPLIT branch outside
                    the shared reducer, plus a fixture asserting both surfaces
                    agree after a 2:1 split and an ADD_SHARES.
Status              unenforced
```

`docs/financial-semantics.md` FIN-003 has the arithmetic: 90 shares at ratio 2.0
is 180, and the additive form gives 92. This invariant is separate from
INV-HOLDING-001 on purpose -- that one is about concurrency, this one about two
implementations of the same rule, and fixing either leaves the other.

### INV-TRANSFER-001 -- both legs, one decision

```text
Statement           A transfer's legs share one status, and any balance movement
                    is decided once for the pair.
Source of truth     the two linked transactions rows
Enforcement         Partial and inconsistent. PATCH /:id/transfer mirrors status
                    to both legs. PATCH /transactions/:id/status, markCleared,
                    reconcile and unreconcile touch only the row given -- the
                    reconciliation service references neither isTransfer nor
                    linkedTransactionId. Bulk update mirrors payeeId, payeeName
                    and description but not status. Balances are updated
                    regardless of status, so a transfer created VOID still moves
                    both.
Concurrency scope   per transfer pair
Failure response    Currently silent imbalance: voiding one leg of a 100.00
                    transfer makes 1,000.00 across two accounts read as 1,100.00.
Required tests      Per status-changing endpoint, assert both legs moved and both
                    balances are consistent. Include the split-transfer variant,
                    which links through the split parent, not a mirror leg.
Status              unenforced
```

### INV-FX-001 -- an unavailable rate is not 1:1

```text
Statement           A cross-currency value must never become a valid-looking 1:1
                    value, and an unconverted amount must never be returned under
                    the target currency's label.
Source of truth     exchange_rates
Enforcement         None at the consumers. The provider layer is honest --
                    getRateForDate returns null explicitly "so the caller can
                    reject or flag the operation rather than silently assuming
                    1.0" -- and the consumers discard that:
                      portfolio-calculation.service.ts:
                        rate = reverseRate !== null ? 1 / reverseRate : 1
                      net-worth.service.ts:
                        return result ?? amount
Concurrency scope   --
Failure response    Must be null or an explicitly partial figure, per
                    docs/financial-calculation-contract.md section 1.
Required tests      Unit per call site with the rate absent; a scanning guard
                    banning a `: 1` else-branch beside a rate lookup and `??
                    amount` beside a conversion.
Status              unenforced
```

At a real rate of 1.3500, a false 100.00 CAD understates a 135.00 CAD position
by 35.00 -- and reports it as measured.

## Scheduled occurrences

### INV-OCCURRENCE-001 -- one occurrence, one effect

```text
Statement           One scheduled occurrence may create at most one financial
                    effect.
Source of truth     the posted transaction; scheduled_transactions.next_due_date
Enforcement         None. processAutoPostTransactions (hourly, at minute 5 --
                    "5 * * * *") reads due schedules by next_due_date <= today,
                    then posts and advances next_due_date with no row lock, no
                    CAS on the previous next_due_date, and no unique constraint
                    on (scheduled_transaction_id, transaction_date). Every
                    replica fires every cron.
Concurrency scope   per (scheduled transaction, occurrence date)
Retry semantics     Unsafe: a retry cannot tell whether the occurrence posted.
Crash semantics     A crash between posting and advancing next_due_date reposts
                    on the next tick.
Failure response    Should be a durable occurrence key claimed atomically.
Required tests      Two-instance: two replicas on one tick, exactly one posting.
Status              unenforced
```

This is `docs/concurrency-and-idempotency.md` CONC-004's canonical case: the
logical operation key is obvious (`(scheduledTransactionId, occurrenceDate)`) and
simply is not persisted.

### INV-OCCURRENCE-002 -- a stored override price survives

```text
Statement           A stored override price is not replaced by a market quote
                    without an explicit user action.
Source of truth     scheduled_transaction_overrides.investment_price
Enforcement         None. OverrideEditorDialog seeds correctly from the stored
                    value, then an unconditional effect overwrites
                    investmentPrice whenever the fetched market price differs
                    from the last seen one, and recomputes the total from it.
Concurrency scope   per occurrence
Failure response    Ten shares stored at 100.00 return as ten at 120.00 with no
                    money field touched by the user.
Required tests      Component: reopen with a stored price and a differing quote,
                    assert the stored price stands.
Status              unenforced
```

## Authentication and authorization

### INV-CLAIM-001 -- a claim token is consumed exactly once

```text
Statement           An emergency-access claim token may be consumed successfully
                    exactly once.
Source of truth     emergency_access_contacts.claim_token_used_at
Enforcement         None. The in-transaction re-read passes no lock option, and
                    the consuming write is an entity save by primary key with no
                    WHERE claim_token_used_at IS NULL. No partial unique index on
                    unused tokens acts as a backstop. The code beside it uses the
                    CAS predicate correctly for voiding sibling tokens. The
                    comment claims re-validation "under lock".
Concurrency scope   per token, per owner
Retry semantics     Two concurrent completes can both rewrite the owner's
                    password, to two different hashes, and both return a signed-in
                    session.
Failure response    The loser must get 404 or 409, having written nothing --
                    docs/financial-calculation-contract.md section 7.
Required tests      Two-connection: one token, two concurrent completes, exactly
                    one success.
Status              unenforced
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
Enforcement         Partial and incidental. The family revoke is an unlocked bulk
                    UPDATE, which is safe against concurrent writers only because
                    is_revoked = true is order-independent -- a property of the
                    value, not a protocol, and one that stops holding the moment
                    logout writes anything else. Whether a failed revoke surfaces
                    to the user was reported by the audit as a defect; it was not
                    located in the current code and is unverified here.
Concurrency scope   per token family
Retry semantics     Safe: setting is_revoked twice is a no-op.
Failure response    A revoke that failed must not clear the client's session
                    silently, or the user believes they signed out and did not.
Required tests      Integration: force the revoke to fail, assert the response is
                    not a success.
Status              partial
```

Split out from INV-AUTH-001 because the two are different properties that happen
to touch the same table. Rotation is about exactly-once; this is about truthful
reporting, and conflating them hid the fact that only the first has a mechanism.

### INV-AUTH-002 -- every failed login is counted

```text
Statement           A failed login attempt increments the counter the lockout
                    threshold reads.
Source of truth     users.failed_login_attempts
Enforcement         None. The user is read in one statement, incremented in
                    JavaScript, and written as an absolute value in a later
                    statement with no lock. Two concurrent failures lose an
                    increment. The comment above it reads "Atomically increment
                    failed attempts".
Concurrency scope   per account
Failure response    The counter under-counts, so lockout arrives late -- the
                    direction that favours an attacker.
Required tests      Two-connection: N concurrent failures, counter equals N.
Status              unenforced
```

The reset-on-success path writes a fixed absolute value (`0`, `null`) and is
therefore safe; only the increment is affected.

### INV-AUTH-003 -- a destructive OIDC action needs a real round trip

```text
Statement           Restore, delete-account, delete-data and step-up on an OIDC
                    account require a signed proof of a fresh identity-provider
                    authentication, bound to the user and the action, single-use
                    and short-lived.
Source of truth     the identity provider
Enforcement         None. The frontend sends the literal string
                    'oidc-session-confirmed' and the backend checks only that the
                    field is truthy; step-up takes a client-asserted
                    oidcConfirmed boolean. No reauth endpoint exists.
Concurrency scope   per user, per action
Failure response    Must be 401 until a valid proof is presented.
Required tests      Integration: a forged or replayed proof is refused; the
                    artifact is single-use and expires.
Status              unenforced
```

Note that the sentinel string is *asserted by tests* in both the frontend and
backend suites. Those tests are green and protect the defect --
`docs/verification-contract.md` section on known-wrong tests covers what to do
with them.

### INV-ACTIVITY-001 -- activity is attributed to whoever acted

```text
Statement           users.last_activity_at records the authenticated user who
                    made the request, never the user they are acting as.
Source of truth     the authenticated principal (req.user.realUserId)
Enforcement         None, and the wrong value is passed. The request-context
                    interceptor resolves both identities -- realUserId is derived
                    as user?.realUserId ?? userId -- and then calls
                    touchLastActivity(userId), the effective user. A delegate
                    browsing an owner's data therefore stamps the owner's
                    last_activity_at.
Concurrency scope   per user
Failure response    --
Required tests      Integration: a delegate request updates the delegate's
                    last_activity_at and leaves the owner's untouched.
Status              unenforced
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
Enforcement         None. users.controller.ts destructures away exactly four
                    fields (passwordHash, resetToken, resetTokenExpiry,
                    twoFactorSecret) and spreads the rest, so
                    pendingTwoFactorSecret, oidcLinkToken, pendingOidcSubject,
                    backupPasswordEnc and emailVerificationToken are returned.
                    The route carries @AllowDelegate().
Concurrency scope   per user, and per delegate
Failure response    --
Required tests      A test that fails when any entity column not on the allowlist
                    appears in the response, so a new column cannot leak by
                    default.
Status              unenforced
```

A removal list is wrong structurally, not incidentally: the default for a new
column is "exposed", so the defect is introduced by a change that never touches
this file. That the route is delegate-accessible means the leak crosses users.

### INV-MCP-001 -- a session is bound to its credential

```text
Statement           An MCP session is bound to the specific credential that
                    opened it, and the presented token's current scopes are
                    re-read on every request.
Enforcement         None. Only the user id is compared, and scopes are captured
                    once at session creation and never re-read.
Concurrency scope   per session, per credential
Failure response    403 on a mismatched credential.
Required tests      Integration: a read-only token presenting a write-scoped
                    session id is refused; a revoked token stops working
                    immediately rather than at TTL.
Status              unenforced
```

### INV-CURRENCY-001 -- shared currency deletion

```text
Statement           A shared currency row is deleted only by its creator, and only
                    when a global reference count -- covering every foreign key in
                    the schema -- is zero, decided under a lock in the deleting
                    transaction.
Source of truth     currencies, and every table referencing currency_code
Enforcement         None sufficient. The authorization check tests
                    createdByUserId !== null ("is it a system currency") rather
                    than === userId, so any user who activated another user's
                    custom currency can trigger its deletion. Both the in-use
                    checks omit budgets.currency_code and both
                    exchange_rates.from_currency/to_currency, all real FKs. The
                    count runs in the caller's tenant scope with no FOR UPDATE on
                    the currency row.
Concurrency scope   global -- cross-tenant
Failure response    403 for a non-creator; 409 while referenced.
Required tests      A test deriving the reference list from schema.sql so a new
                    FK cannot be forgotten; two-connection delete-versus-use.
Status              unenforced
```

The tenant-scoped count is the part that gets worse rather than better under
`RLS_MODE=enforce`: a "global" count that sees only the caller's rows reports
zero for another user's references.

## External effects

### INV-ATTACHMENT-001 -- metadata resolves to committed bytes

```text
Statement           Attachment metadata that a user can see resolves to bytes
                    that are durably present, and no bytes exist without
                    metadata.
Enforcement         Provider-dependent. The database provider is genuinely atomic
                    -- its save joins the ambient transaction. Local and S3 write
                    bytes inside the transaction callback, before the commit, so
                    a failed commit leaves an orphan that no sweep, no
                    compensation and no reconciliation job will ever find. The
                    comment claims joint commit for all providers.
Concurrency scope   per attachment
Retry semantics     Deletes are idempotent on a missing key; creates are not.
Crash semantics     Orphaned bytes accumulate silently.
Status              partial
```

### INV-BACKUP-001 -- a backup is complete, verified, owner-namespaced

```text
Statement           A backup artifact is namespaced by owner, written completely,
                    and verified before it is reported as done.
Enforcement         Namespacing: enforced. userFolderPath uses
                    shardedSegments(userId) for <base>/<ab>/<cd>/<userId>/,
                    because the filenames carry only a tier and a date -- a flat
                    folder gave every user the same name for the same day and
                    whoever's cron ran last overwrote the rest. Folder browse and
                    validate are admin-gated.
                    Completeness: none. A single fs.writeFile to the final name,
                    no temp file, no fsync, no rename, no size check, no
                    checksum; lastBackupStatus is set to success immediately
                    after. Retention promotes the daily to weekly and monthly
                    with copyFileSync, so a truncated file propagates. Restore
                    validates only the version number and exportedAt.
Concurrency scope   per user
Crash semantics     A kill or ENOSPC mid-write leaves a truncated file under the
                    expected name, indistinguishable from a complete one.
Required tests      Provider round trip: write, truncate, assert restore refuses.
Status              partial
```

Encryption is settled and worth not re-litigating: a support backup is
unconditionally encrypted because it exists to leave the user's machine, and an
automatic backup whose stored password cannot be decrypted is *refused* rather
than written in clear.

### INV-CRON-001 -- one logical effect per tick

```text
Statement           A scheduled job produces one logical effect per tick,
                    regardless of replica count.
Enforcement         Per job, and inconsistent. Real mechanisms: the MNY reaper's
                    conditional CAS; the price and FX refreshes' natural-key
                    ON CONFLICT ... DO UPDATE; sweeps that are idempotent by
                    construction because the predicate is "already expired". No
                    mechanism: scheduled auto-posting (INV-OCCURRENCE-001);
                    budget-period rollover, where UNIQUE(budget_id, period_start)
                    is the only backstop and the loser's violation is swallowed
                    by a per-budget try/catch that increments an error count;
                    demo reset, which can interleave one run's delete with
                    another's insert; the account-balance recompute, idempotent
                    against itself but not against a concurrent delta.
                    AI insight generation guards with a process-local Set, which
                    coordinates one replica with itself and nothing across
                    replicas.
Concurrency scope   per job, per logical key
Required tests      Two-instance per job. Only the MNY job has one.
Status              partial
```

`docs/cron-jobs.md` lists schedules; per section 7 of
`docs/concurrency-and-idempotency.md` it must also record, per job, what prevents
two replicas from producing the same effect.

## Platform

### INV-RLS-001 -- enforced mode refuses a privileged role

```text
Statement           Under RLS_MODE=enforce the application refuses to serve
                    traffic on a role that can bypass row-level security --
                    including membership reachable via SET ROLE, not only the
                    role's own attributes.
Enforcement         None. No startup check exists; no pg_has_role or rolbypassrls
                    interrogation appears anywhere in backend/src. app-role.ts
                    provisions and grants but never asks what the connecting role
                    actually is.
Concurrency scope   global, at startup
Failure response    Refuse to boot.
Required tests      Integration against a superuser and a BYPASSRLS role, and
                    against a role that merely inherits membership in an exempt
                    one.
Status              unenforced
```

This is the backstop for the entire RLS design: if enforced mode is ever switched
on with a misconfigured role, nothing notices. It is latent rather than
exploitable at the `RLS_MODE=off` default -- and the same condition applies to
delegation's cross-user lookups, which run in the caller's tenant scope today and
would silently return zero rows under enforcement.

Related and also absent: `db-init` and `db-migrate` are not serialized across
replicas by an advisory lock, so each pod decides independently from its own read
of `schema_migrations`.

### INV-CACHE-001 -- a money-moving write invalidates its caches

```text
Statement           A write that changes money invalidates every client cache
                    family derived from transactions.
Enforcement         None. invalidateBalanceCaches drops the 'accounts:' and
                    'investments:' prefixes only; 'budgets:' is a live prefix and
                    is not dropped.
Concurrency scope   per browser tab
Failure response    A saved transaction leaves the budget progress bar showing
                    the pre-write figure for up to the cache TTL.
Required tests      A classification guard requiring every cache prefix in src/
                    to declare itself transaction-derived or reference data, so a
                    new family cannot default to stale.
Status              unenforced
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

`docs/release-integrity.md` has the full rules and gap register, including the
unconditional `--passWithNoTests` on the integration suite.

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
