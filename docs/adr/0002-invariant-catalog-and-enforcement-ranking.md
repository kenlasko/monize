# 0002. Invariants are catalogued, and enforced as low in the stack as possible

Status: accepted
Date: 2026-08-04

## Context

An audit of the codebase produced a large number of findings across many
subsystems -- imports, balances, holdings, scheduled posting, emergency access,
attachments, backups, crons, release automation. Read individually they looked
like unrelated bugs. Read together, most were repeated manifestations of a much
smaller set of missing cross-layer contracts: no shared serialization protocol
for a derived value, no lifecycle for a non-transactional external effect, no
single definition of what a financial field means, and no statement of what kind
of test a given claim requires.

The repository was not undisciplined. It had `withScopedDb`, atomic balance
arithmetic, a database-enforced import claim with real two-connection tests,
RLS enforcement tests, and substantive migration and drift checks. What it did
not have was those patterns organised into one contract, so adjacent workflows
used incompatible protocols -- one balance path an atomic delta, another an
absolute recomputation from a snapshot, each individually transactional and
unsafe together.

A second observation shaped the decision more than the first. The financial
contracts in `docs/` had already been read, agreed with, and violated anyway,
more than once. Prose stating a rule was demonstrably insufficient on its own.

## Decision

**Maintain a catalog of cross-layer invariants** in `docs/system-invariants.md`,
each with a stable ID, a named enforcement mechanism, a concurrency scope, retry
and crash semantics, required tests, and an honest status of `enforced`,
`partial` or `unenforced`.

**State the status truthfully, including when the system violates the
invariant.** An entry describing a condition the code does not meet, with the
violation cited, is the useful form. The catalog is a target, not a description.

**Enforce each rule as low in the stack as it will go.** Ranked by how well they
hold:

1. a type the compiler enforces
2. a lint rule
3. a database constraint, index or single atomic statement
4. a test that scans the source for the mistake anywhere
5. a test of one call site
6. a paragraph in a `CLAUDE.md` or a contract document

Reach for the highest the mistake allows. Use prose for the part that genuinely
needs judgement, not as the first resort.

**Prefer a scanning test wherever the mistake is mechanical.** When a defect can
appear at many call sites -- a missing-rate fallback of `1`, a `SPLIT` case
outside the shared reducer, a raw element instead of the shared component -- a
test that fails for *any* occurrence is the durable form.
`frontend/src/test/ui-conventions.test.ts` is the pattern.

**Treat a defect found by a human in AI-written code as a missing rule.** Fixing
it is half the work; the other half is finding how the codebase already solves
that problem, adding a regression test that fails on the original mistake, and
writing the rule down.

## Consequences

**Makes easy.** A reviewer can check a diff against a named invariant rather than
against their memory. A change that closes a gap has one place to update. The
repeated-rediscovery pattern -- the same FX and stock-split defects independently
found and fixed in several parallel efforts -- becomes visible as one row instead
of many bugs.

**Makes hard.** Every invariant-bearing pull request now owes: the IDs it
touches, the enforcement mechanism, the required test kind, and a status update.
That is real friction, and it is the point.

**Forbids.** Closing a finding by adding prose. An invariant moves to `enforced`
only when a mechanism makes the violation fail.

**A specific obligation.** A document that names an identifier is making a claim
about the source. Renaming or deleting a field, flag or helper means grepping
`docs/` and every `CLAUDE.md` in the same commit. These contract documents cite
file paths, job names, script names and flags throughout, so they are subject to
this rule more than most -- a document describing a model that no longer exists
gets read, believed, and built on.

## Alternatives considered

**Write more documentation without status fields.** Rejected: a document that
describes intended behaviour indistinguishably from actual behaviour is how
comments came to claim atomicity, single-use consumption and locks that the code
beside them did not implement. Those claims were believed for as long as they
existed.

**Fix the findings and skip the catalog.** Rejected because the findings were
manifestations rather than causes. Several were independently rediscovered and
re-fixed in parallel efforts that did not know about each other, and a
single-call-site fix repeatedly left siblings live.

**Track invariants in the issue tracker instead.** Rejected: an issue is closed
and then invisible. An invariant is permanent -- its enforcement must be
checkable during review years later, which means it belongs in the repository
beside the code.

**Machine-check everything and write nothing.** Rejected as not achievable
today. Some rules genuinely need judgement -- which of `null`, `0` and absent a
new field means; whether an unclaimed cron is idempotent by construction. Those
need prose. The mistake is using prose for the rules that could have been
checked.
