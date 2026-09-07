# Verification Contract

Which kind of test each invariant requires, and which CI job enforces it. The
repository has many tests, including real PostgreSQL suites; what it has not had
is a normative statement of *what kind* of test a given claim needs. That gap is
why several defects lived behind green suites, and why six tests were found
asserting the wrong outcome.

Related: `docs/testing-contract.md` lists the adversarial inputs to pick from
(dates, money precision, aggregation, currency conversion, ownership,
concurrency) so an author chooses from a list rather than recalling edge cases.
This document is about test *kind* and *placement*, not input selection.
`docs/system-invariants.md` defines the IDs used below.

## 1. The test kinds

| Kind | What it can prove | Where it lives |
| --- | --- | --- |
| Unit | Pure logic, arithmetic, sign and precision rules, validation branches | `backend/src/**/*.spec.ts`, `frontend/src/**/*.test.ts` |
| Source scan | That a mistake appears nowhere, rather than not in the one place tested | any suite; see `frontend/src/test/ui-conventions.test.ts` |
| PostgreSQL integration | Real constraints, cascades, triggers, RLS policies, SQL semantics | `backend/test/integration/*.integration.spec.ts` |
| Two connections | Lock ordering, statement snapshots, one-winner CAS, partial-index arbitration | same, with two `DataSource` connections and `Promise.all` |
| Two instances | Process-local state failing across replicas; cron claim mechanisms | same, two service instances over one database |
| Failpoint | Crash between an external effect and its commit | same, by throwing at the boundary |
| Provider round trip | Bytes actually written and readable; a truncated artifact refused | same, against local filesystem and S3 |
| E2E | The user-visible outcome, and browser/cache state | `e2e/tests/*.spec.ts` |

## 2. What a mock cannot prove

A mocked repository can be made to return whatever a branch needs, which makes
that branch testable, tested, and dead. This is not hypothetical here:

- `mny-import-job.service.ts` carries a helper, `returnedRows`, that exists
  because a data-modifying statement with `RETURNING` comes back from
  `manager.query()` as `[rows, rowCount]` while a bare `SELECT` returns plain
  rows. Reading the tuple as `rows.length > 0` made **every** CAS attempt look
  like a winner. Its comment records that this was found by the concurrency
  spec -- the real-database one. No unit test could have found it, because the
  mock returned whatever shape the test author assumed.
- `gem-price.integration.spec.ts` states the same lesson about its own subject:
  with a mock, "every lost-race branch was dead, tested and unreachable."

So mocks are supporting evidence only for anything claiming a property of
PostgreSQL, of multiple processes, of a provider, or of browser state:

```text
VER-001
A test asserting that a service called `save`, `update` or `transaction` proves
the call, not the property. Where the invariant is a property of PostgreSQL,
multiple processes, a provider or the browser, a mock-based test is supporting
evidence and a production-boundary test is mandatory.

VER-002
A concurrency mechanism with only unit tests is untested. Two-connection means
two real connections interleaved, not two sequential calls on one.

VER-003
An invariant's entry in docs/system-invariants.md names its required tests. A
change that adds enforcement adds the required test in the same commit; a change
that cannot must say so in the pull request.
```

## 3. The matrix

`required` means the invariant is not verified without it. `supporting` means it
adds value but proves nothing on its own. `--` means not applicable.

`required (not yet met)` is the one cell that is a statement about the code
rather than about the test kind: the invariant needs that test and does not have
it. It is spelled out because `--` reads as "nothing owed", and an acknowledged
gap recorded as "not applicable" is a gap that disappears from the audit --
INV-LOAN-002's entry names the missing source scan while its row said `--`.

| Invariant | Unit | Source scan | PG integration | Two connections | Two instances | Failpoint | Provider | E2E |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| INV-IMPORT-001 one active import | supporting | -- | required | **required** | required | supporting | -- | optional |
| INV-IMPORT-002 retry never doubles | supporting | -- | required | required | -- | **required** | -- | required |
| INV-IMPORT-003 category collision | supporting | -- | required | **required** | -- | -- | -- | -- |
| INV-BALANCE-001 balance equals ledger | supporting | -- | required | **required** | optional | required | -- | required |
| INV-HOLDING-001 holding replay | supporting | -- | required | **required** | optional | required | -- | optional |
| INV-HOLDING-002 one reducer | required | **required** | supporting | -- | -- | -- | -- | required |
| INV-TRANSFER-001 both legs | required | -- | required | optional | -- | -- | -- | required |
| INV-REDEEM-001 accrued interest | required | **required** | required | -- | -- | -- | -- | optional |
| INV-RECONCILE-001 reconciled lock | supporting | **required** | required | required | -- | -- | -- | optional |
| INV-FX-001 no 1:1 fallback | **required** | **required** | required | -- | -- | required | optional | required |
| INV-REPORT-001 report account scope | supporting | **required** | **required** | -- | -- | -- | -- | optional |
| INV-REPORT-002 chart reduction | **required** | **required** | -- | -- | -- | -- | -- | -- |
| INV-LOAN-001 overpayment cadence | **required** | -- | -- | -- | -- | -- | -- | optional |
| INV-LOAN-002 no truncated total | **required** | **required** (not yet met) | -- | -- | -- | -- | -- | optional |
| INV-LOAN-003 compounding convention | **required** | **required** | -- | -- | -- | -- | -- | -- |
| INV-LOAN-004 residual final payment | **required** | -- | -- | -- | -- | -- | -- | -- |
| INV-LOAN-005 first payment is payment 1 | **required** | **required** | -- | -- | -- | -- | -- | -- |
| INV-LOAN-006 dated installment pricing | **required** | **required** | required | -- | -- | -- | -- | optional |
| INV-LOAN-HISTORY-001 ledger-backed loan interest | **required** | required | -- | -- | -- | -- | -- | optional |
| INV-OCCURRENCE-001 one effect | supporting | -- | required | required | **required** | required | -- | required |
| INV-OCCURRENCE-002 override price | required | -- | -- | -- | -- | -- | -- | required |
| INV-OCCURRENCE-003 one effective occurrence | **required** | **required** | -- | -- | -- | -- | optional | optional |
| INV-CLAIM-001 single-use claim | supporting | -- | required | **required** | optional | optional | -- | required |
| INV-AUTH-001 refresh rotation | supporting | -- | required | **required** | -- | -- | -- | optional |
| INV-AUTH-002 login counter | supporting | -- | required | **required** | -- | -- | -- | -- |
| INV-AUTH-003 OIDC round trip | required | -- | required | -- | -- | -- | required | required |
| INV-AUTH-004 truthful logout | supporting | -- | required | -- | -- | **required** | -- | required |
| INV-ACTIVITY-001 activity attribution | supporting | -- | **required** | -- | -- | -- | -- | -- |
| INV-PROFILE-001 allowlist | required | **required** | supporting | -- | -- | -- | -- | -- |
| INV-DISPLAY-001 reader's number locale | **required** | **required** | -- | -- | -- | -- | -- | optional |
| INV-MCP-001 request identity | **required** | **required** | required | -- | -- | -- | -- | -- |
| INV-MCP-002 transport answers MCP | **required** | -- | -- | -- | -- | -- | -- | optional |
| INV-MCP-003 confirmation binding | **required** | **required** | -- | -- | -- | -- | -- | -- |
| INV-MCP-004 answered before written | **required** | **required** | -- | -- | -- | -- | -- | -- |
| INV-CURRENCY-001 currency delete | supporting | **required** | required | required | -- | -- | -- | optional |
| INV-ATTACHMENT-001 bytes present | supporting | -- | required | optional | -- | **required** | **required** | required |
| INV-ATTACHMENT-002 scan pair is one | **required** | **required** | **required** | -- | -- | -- | -- | **required** |
| INV-BACKUP-001 backup complete | supporting | -- | required | -- | optional | **required** | **required** | required |
| INV-PUSH-001 subscription ownership | required | -- | **required** | required (not yet met) | -- | -- | -- | optional |
| INV-PUSH-002 private key stays server-side | supporting | **required** | -- | -- | -- | -- | -- | -- |
| INV-PUSH-006 channel offered only while usable | **required** | -- | optional | -- | -- | -- | -- | -- |
| INV-PUSH-003 rotation retires subscriptions | **required** | -- | required | -- | -- | -- | -- | -- |
| INV-PUSH-004 push failure is reported | **required** | -- | optional | -- | -- | required | required | -- |
| INV-PUSH-005 subscription not portable | supporting | -- | **required** | -- | -- | -- | -- | -- |
| INV-PUSH-007 one push sender | supporting | **required** | -- | -- | -- | -- | -- | -- |
| INV-PUSH-008 transport gates its wire | **required** | -- | optional | -- | -- | -- | -- | optional |
| INV-PUSH-009 unsupported channel forced off | **required** | **required** | -- | -- | -- | -- | -- | -- |
| INV-PUSH-010 endpoint validated, transport list held equal | **required** | **required** | -- | -- | -- | -- | -- | -- |
| INV-CRON-001 one effect per tick | supporting | -- | required | required | **required** | optional | -- | -- |
| INV-PROVIDER-001 outage reported once | required | **required** | required | optional | required | -- | required | -- |
| INV-ALERT-001 system alert raised once | required | -- | **required** | optional | required | -- | -- | -- |
| INV-NOTIFY-001 one notification writer | supporting | **required** | -- | -- | -- | -- | -- | -- |
| INV-DISPATCH-001 seam never writes | supporting | **required** | -- | -- | -- | -- | -- | -- |
| INV-DISPATCH-002 in-app row always written | **required** | -- | optional | -- | -- | -- | -- | -- |
| INV-DISPATCH-003 throttle gates fan-out only | **required** | -- | optional | required (not yet met) | optional | -- | -- | -- |
| INV-DISPATCH-004 delivery failure never surfaces | **required** | -- | -- | -- | -- | required | -- | -- |
| INV-RLS-001 role privilege | supporting | -- | **required** | -- | required | -- | -- | -- |
| INV-CACHE-001 cache invalidation | required | **required** | -- | -- | -- | -- | -- | required |
| INV-PAYEE-001 lookup never overwrites | **required** | supporting | optional | optional | -- | -- | -- | -- |
| INV-PAYEE-002 Google Places monthly cap | optional | supporting | **required** | -- | -- | -- | -- | -- |
| INV-RELEASE-001 one revision | required | -- | -- | -- | -- | -- | -- | workflow self-test |
| INV-MIGRATION-001 numeric prefix order, collision-free prefix | required | **required** | supporting | -- | -- | -- | -- | -- |

Bold marks the kind that is load-bearing -- the one whose absence means the
invariant is unverified no matter how many others pass. `INV-PROFILE-001`'s is a
source scan rather than a unit test because the defect arrives via a change to a
different file: a new entity column. `INV-FX-001` and `INV-HOLDING-002` need
scans for the same reason -- both are scattered across call sites, and every
previous fix corrected one and left the others. `INV-RECONCILE-001` is the same
shape: the strict lock is only as strong as its least-guarded entry point -- a
single-row refusal was once walked around by `bulkUpdate` -- so
`reconciled-lock.guard.spec.ts` scanning every write path is the load-bearing
kind, not any one service test. `INV-REDEEM-001` too: proceeds and accrued
interest are added in exactly one place, and `accrued-interest.guard.spec.ts`
failing a hand-rolled addition anywhere else is what keeps the cash from being
moved twice.

`INV-LOAN-HISTORY-001` is the opposite arrangement, and worth stating because it
is the exception the previous paragraph would lead you to guess wrong. Its
load-bearing kind is the **unit** test, not the scan: there is exactly one
producer of historical loan interest (`deriveLoanPaymentHistory`, in the
frontend), so the defect cannot arrive from a second call site, and what has
actually gone wrong every time is the *arithmetic decision* inside it -- an
estimate substituted for an absent ledger fact, then a rate dropped along with
the interest, then escrow read as interest because it was listed first. Those are
caught by a case, not by a pattern. The scans
(`loan-history.guard.test.ts`) are `required` rather than load-bearing because
each proves a narrower thing: that no `catch` reappears in the module, since a
swallowed lookup resolves to `[]` and `[]` is read as "no interest was booked";
and that no surface reads a resolved annual rate for truthiness, since `0` is a
rate and five sites reported a recorded 0% as "Not set". That second one is the
shape where a scan *is* the right instrument -- one mechanical mistake repeated
across five files -- and it carries a self-test over known good and bad lines,
because a pattern that has silently stopped matching still passes.
The unit matrix is what has to be exhaustive -- every account type, compounding
flag, frequency and timeline combination was a separate door into the estimate,
and a single-fixture test closed only one of them.

`INV-IMPORT-002`'s load-bearing kind is a **failpoint**, and it is worth
understanding why the other columns cannot substitute. The MNY import has real
two-connection tests -- more than any other workflow -- and they all interleave
*starts* and *claims*. None of them commits the business write and then fails, so
none of them enters the window where a retry duplicates data. A suite can be
genuinely strong at one failure mode and blind to the neighbouring one, and
counting tests will not reveal it. The failpoint that would:

```text
1. let writeAll() commit
2. throw immediately after, before terminal job completion
3. retry the job against the same staged file
4. assert every imported row exists exactly once
5. assert the job state distinguishes committed-but-unfinalized from retryable
```

A test that throws *inside* the import transaction passes today and proves
nothing about this.

## 4. CI ownership

Every required test must be reachable by a named job. The jobs that exist in
`.github/workflows/ci.yml`:

| Job | Runs | Owns |
| --- | --- | --- |
| `Backend Lint & Type Check` | eslint, tsc | the RLS lint bans, ban lists |
| `Backend Unit Tests` | `npm run test:unit -- --coverage` | unit, source scans in `backend/src` |
| `Backend Integration Tests` | `npm run test:integration` | PG integration, two-connection, two-instance, failpoint, provider round trip |
| `Frontend Unit Tests` | `npm run test:cov` | unit, source scans in `frontend/src` |
| `Frontend Lint & Type Check` | eslint, tsc | frontend conventions |
| `Schema vs Migrations Drift` | `scripts/verify-schema.sh` | migration replay is a no-op on `schema.sql` |
| `E2E Tests (shard N/4)` | Playwright, 4 shards | user-visible outcomes, browser cache state |
| `Lighthouse audit` | Lighthouse CI | accessibility and performance budgets |

Two structural points about this table:

**One job owns six test kinds.** `Backend Integration Tests` is where
two-connection, two-instance, failpoint and provider round-trip tests all live,
because they all need a real database. That makes it the single most important
job in the pipeline and the one whose silent failure is most costly -- which
brings us to the next point.

**That job no longer passes having run nothing -- but nothing asserts its suite
count.** `test:integration` previously carried an unconditional
`--passWithNoTests`, so a renamed directory or an edited `testPathPatterns` regex
turned a discovery failure into a green check across all six kinds at once. That
flag has since been removed from `backend/package.json`, so an empty match now
exits non-zero and fails the job, and
`backend/src/common/jest-config.guard.spec.ts` fails if the flag reappears on
any tracked surface that can start a runner -- manifest, runner config,
workflow, shell script or Dockerfile -- in every spelling the runners accept. What is still owed is the weaker guard against a regex that matches *some*
suites but silently drops a class: that guard asserts every tracked suite under
`backend/test/integration/` is discoverable by `test/jest-e2e.json`, but nothing
asserts what the runner executed, and the CLI `--testPathPatterns` filter is
outside its model.
`docs/release-integrity.md` REL-001 and REL-002 cover the history and the
consequence, which is a verification one, not merely CI hygiene.

## 5. Known-wrong tests

A green test is evidence only for the behaviour it asserts. If the assertion
encodes the defect, the test is a regression protector for the wrong outcome --
and it is worse than no test, because it will be cited as coverage.

```text
VER-004
A test that asserts current behaviour without a reason to believe it correct is
not coverage. When an invariant is found violated, search the suites for tests
asserting the violation and correct them in the same change -- they are why the
defect survived.
```

### Located in the current suites -- all since corrected

Four known-wrong tests were found here and have since been corrected, in the same
work that moved their invariants to `enforced` (or, for the loan ones, to
`partial`). They are recorded rather than deleted, because the rule they
illustrate (VER-004) is the point, and a reader should be able to confirm the
correction rather than take it on trust.

| Test | Asserted (now corrected) | Was protecting |
| --- | --- | --- |
| `backend/src/scheduled-transactions/scheduled-transaction-loan.service.spec.ts` | That the loan recalculation **rewrites** a template it cannot account for. Two of these asserted the rewrite for a template carrying an unmanaged line, which leaves the parent unequal to the sum of its children -- so the posting path's exact-4dp validator refuses every occurrence and the schedule stops posting silently. They now assert the decline. | INV-LOAN-HISTORY-001 |
| `frontend/src/components/reports/LoanAmortizationReport.test.tsx` | That the account picker **disappears** when one loan's data fails to load (`queryByText('Select Loan')).not.toBeInTheDocument()`). The selection is persisted, so replacing the whole report restores that loan's error on every visit with no in-page way to choose another account. It now asserts the schedule is withheld and the picker stays. | INV-LOAN-HISTORY-001 |
| `backend/src/net-worth/net-worth.service.spec.ts` | Additive stock-split replay (`... + SPLIT 90 = 180 shares`). The suite now applies the **multiplicative** rule -- a 2-for-1 split multiplies the position (50 shares -> 100), and the comment records that the old additive fixture was replaced. | INV-HOLDING-002 |
| `frontend/src/components/settings/BackupRestoreSection.test.tsx`, `frontend/src/components/settings/DangerZoneSection.test.tsx`, `backend/src/users/users.service.spec.ts`, `backend/src/backup/backup.service.spec.ts` | `oidcIdToken: 'oidc-session-confirmed'` accepted as proof. The suites now send the real signed reauth artifact and **reject** the sentinel (and any non-empty string); the literal survives only in comments describing the old defect. | INV-AUTH-003 |

The AUTH-003 case is the clearest of the category: the sentinel was asserted on
both sides, so the tests did not merely tolerate the defect -- they specified it,
and a real OIDC round trip could not land until they changed.

The two LOAN-HISTORY cases are the youngest, and both were written by the same
work that then had to correct them -- which is the honest version of how this
category arises. Neither was careless: each asserted, precisely, what the code
did one commit earlier. That is exactly VER-004's warning, and the reason the
rule is "search the suites when an invariant is found violated" rather than
"trust that a green suite means the invariant holds".

The HOLDING-002 case is the more instructive one. It read as a careful test: five
actions, three months, arithmetic worked out in a comment -- and the arithmetic
was simply the wrong rule, applied consistently, which a reviewer checking code
against test would have found to match.

### Reported but not located

The audit that prompted this document also reported tests asserting a missing
exchange rate as 1:1, an overwritten scheduled override price, a failed logout
presented as successful, and unsafe backup naming expectations. **Searching the
current suites did not find them.** Each is one of three things, and they are
worth distinguishing before acting:

- already corrected on `main` since the audit -- the backup-naming case is
  probably this, since per-user sharding landed and the remaining filename
  assertions are about the filename, which is correct; the sharding is in the
  directory;
- present but not matched by the searches used;
- or never precisely located by the audit either.

They are recorded here as unconfirmed rather than dropped, because a reader
closing INV-FX-001 or INV-OCCURRENCE-002 should search once more before assuming
no test stands in the way. They are deliberately not in the table above: a
citation that cannot be checked is the thing this document exists to discourage.

Per root `CLAUDE.md`, each corrected unit test needs a production-boundary
companion wherever the defect depends on PostgreSQL, multiple processes,
providers or browser state. Correcting the assertion alone leaves the class open.

## 6. A green suite after a behaviour change is a finding

Restating `docs/financial-calculation-contract.md` section 8.1 because it is the
rule most often skipped: if you changed what the code produces and nothing
failed, either the change is a no-op or the suite had no case for it. Say which
in the change description, and if it is the second, add the case in the same
commit.

### The load-bearing source scans now exist

Section 3 marks a source scan as load-bearing for INV-FX-001, INV-HOLDING-002,
INV-PROFILE-001, INV-CURRENCY-001 and INV-CACHE-001. Each was owed when this
document was first written; each is now written, in the pattern of
`frontend/src/test/ui-conventions.test.ts`, alongside the fix to the invariant it
scans:

| Scan | Fails on | File |
| --- | --- | --- |
| FX fallback | a `: 1` else-branch beside a rate lookup, or `?? amount` beside a conversion | `backend/src/common/fx-fallback.guard.spec.ts` |
| Share replay | a `SPLIT` case outside the single shared reducer | `backend/src/securities/investment-replay.guard.spec.ts` |
| Profile response | an entity column absent from the response allowlist | `backend/src/users/user-profile.spec.ts` |
| Currency references | an FK to `currency_code` in `schema.sql` that the in-use check does not cover | `backend/src/currencies/currency-references.spec.ts` |
| Cache families | a cache prefix in `src/` that declares itself neither transaction-derived nor reference data | `frontend/src/lib/cache-prefix-classification.guard.test.ts` |

Each had to be born with the fix rather than alone: a guard introduced against
still-broken code either breaks the suite or needs a baseline-exception list,
which is a decision about how much known-wrong code to bless. They landed the
right way -- with the fix, so no exception list -- which is why INV-FX-001 and
INV-HOLDING-002 are no longer guarded only by prose.

The corollary for this document: a test you have never seen fail protects
nothing. When adding a required test from section 3, run it against the
unfixed code first and confirm it fails for the right reason.

## 7. Running the suites so a green branch does not read as red

CI runs in UTC with one Playwright worker; a local run does neither, and both
differences produce failures that look like regressions and are not.

- `TZ=UTC npm run test:unit` matches CI. Some tests read `new Date()` and count
  completed periods against fixtures; under another offset they land on the wrong
  side of a boundary. `insights-aggregator.service.spec.ts` and
  `net-worth.service.spec.ts` are the ones that bite.
- `npm test` in `backend/` runs `test:unit && test:integration` -- the two CI
  commands above, in that order, never concurrently. The integration suites share
  one `monize_test` and rebuild its schema (`synchronize` + `dropSchema`), so a
  second Jest worker is a race rather than a speedup: the parallel config pins
  `roots: ["<rootDir>/src"]` and `test/jest-e2e.json` pins `maxWorkers: 1`, both
  asserted by `backend/src/common/jest-config.guard.spec.ts`. The default command
  therefore needs a reachable PostgreSQL; `npm run test:unit` is the offline path.
- `--workers=1` for the whole E2E suite. `playwright.config.ts` sets one worker
  only when `CI` is set, and `e2e/tests/zz-danger-zone.spec.ts` deletes the
  shared account -- the `zz-` prefix orders it last, which only means anything
  serially. A single spec file is safe without the flag.
- `scripts/verify-schema.sh` reproduces the drift job locally and needs only
  Docker.

Believing an unqualified local failure means chasing a bug that does not exist;
root `CLAUDE.md` has the longer form.

## 8. Definition of done

For a change that touches an invariant:

1. the invariant IDs are named in the pull request;
2. each required test from section 3 is added, or an existing one is cited by
   path and test name;
3. the load-bearing kind (bold in the matrix) is present, not substituted with a
   mock;
4. each new test was seen to fail against the unfixed code;
5. any test asserting the old, wrong behaviour is corrected in the same change;
6. the CI job from section 4 that enforces it is named;
7. the invariant's status in `docs/system-invariants.md` is updated, and the
   citation of the violation deleted if it no longer exists.
