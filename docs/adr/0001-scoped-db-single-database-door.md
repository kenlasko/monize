# 0001. `withScopedDb` is the only door to the database

Status: accepted
Date: 2026-08-04 (recorded retrospectively; the decision was made and
implemented earlier, across RLS tasks R1-R7 and lint task L1)

## Context

Row-level security requires that every database session carry the identity it is
acting as, in a PostgreSQL GUC the policies read. That is a property of *every*
query, not of the queries someone remembered to annotate -- one unscoped read is
enough to return another tenant's rows.

Before this decision the codebase reached the database three ways: injected
repositories (`@InjectRepository`), manually managed `QueryRunner`s, and bare
`dataSource.query`. Each carried its own commit, rollback and release
bookkeeping, and none of them could carry a tenant identity without every call
site opting in. Around 91 such sites existed.

Two further forces mattered. Multi-table and read-modify-write operations were
the codebase's most common source of bugs, and a per-call-site transaction
discipline had already proven insufficient. And a helper that opened its own
transaction while its caller held one would take a second pooled connection,
which under load deadlocks the pool rather than merely being wasteful.

## Decision

All database access goes through `withScopedDb` (`backend/src/common/db/scoped-db.ts`).

- Services inject `DataSource`, never a repository. Repositories come from the
  transaction's `EntityManager`. Helpers take an `EntityManager`, never a
  `QueryRunner`.
- `withScopedDb` sets the identity GUCs as the transaction's first statements
  using `set_config(..., true)`, so they are transaction-local and cannot leak
  onto a pooled connection.
- It **throws** without an ambient identity context rather than falling back to
  `dataSource.manager`. Callers the request interceptor cannot see must seed
  their own: `withUserContext`, `withSystemContext`, `withDelegateContext`, or
  `withPreserveTimestamps`.
- A nested call **joins** the ambient transaction -- same connection, same
  atomicity -- so a service method calling another is safe.
- ESLint bans `InjectRepository` and `.createQueryRunner()` in `src/`, and
  restricts importing `common/db/with-context` to an explicit allowlist.

## Consequences

**Makes easy.** Atomicity is the default rather than something to remember.
Adding an RLS policy does not require auditing call sites. Refactoring a service
method into two cannot accidentally split a transaction.

**Makes hard.** Deliberately: a background timer or a progress write that a
concurrent reader must see now needs `runOutsideActiveScopedManager`, which is
explicit and reviewable. Genuinely cross-user work needs
`withSystemContext`, which is logged and allowlisted.

**Forbids.** Any new `@InjectRepository` field, `createQueryRunner()` call, or
bare `dataSource.query`. A `createQueryRunner()` in a diff is new and wrong --
there are none left in `src/`.

**Does not provide, and is regularly assumed to.** `withScopedDb` gives
atomicity and identity. It gives **no** protection against a concurrent writer of
the same row: the default isolation is READ COMMITTED, so two transactions may
each read a value, each compute a new one, and each write. This was the single
most common misreading of the primitive, and it is why
`docs/concurrency-and-idempotency.md` exists as a separate contract. A callback
that returns early commits an empty transaction, which is the correct replacement
for an explicit rollback.

## Alternatives considered

**Keep repositories, add an interceptor that sets the GUC per request.** Rejected
because it covers only request-scoped work. Crons, bootstrap hooks, seeders and
bearer-only routes have no request, and those are exactly the surfaces where a
missing identity is least likely to be noticed -- the `/mcp` transport has no
`AuthGuard('jwt')`, so an interceptor's scope would carry an undefined user id.

**A repository base class that injects the GUC.** Rejected: it cannot express a
multi-table transaction, which is the case that most needed fixing, and it leaves
`dataSource.query` as an open side door.

**Application-level tenant filtering instead of RLS.** Rejected because it is a
convention rather than a mechanism -- one forgotten `where` clause is a
cross-tenant leak, and no test can prove the absence of a missing clause across
a whole codebase.

**Allow nested calls to open independent transactions.** Rejected on pool
deadlock. Joining also gives the more useful semantics: an inner failure rolls
back the outer work, which is what a caller almost always wants.
