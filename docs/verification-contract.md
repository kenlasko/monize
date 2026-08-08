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

| Invariant | Unit | Source scan | PG integration | Two connections | Two instances | Failpoint | Provider | E2E |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| INV-IMPORT-001 one active import | supporting | -- | required | **required** | required | supporting | -- | optional |
| INV-IMPORT-002 retry never doubles | supporting | -- | required | required | -- | **required** | -- | required |
| INV-IMPORT-003 category collision | supporting | -- | required | **required** | -- | -- | -- | -- |
| INV-BALANCE-001 balance equals ledger | supporting | -- | required | **required** | optional | required | -- | required |
| INV-HOLDING-001 holding replay | supporting | -- | required | **required** | optional | required | -- | optional |
| INV-HOLDING-002 one reducer | required | **required** | supporting | -- | -- | -- | -- | required |
| INV-TRANSFER-001 both legs | required | -- | required | optional | -- | -- | -- | required |
| INV-FX-001 no 1:1 fallback | **required** | **required** | required | -- | -- | required | optional | required |
| INV-OCCURRENCE-001 one effect | supporting | -- | required | required | **required** | required | -- | required |
| INV-OCCURRENCE-002 override price | required | -- | -- | -- | -- | -- | -- | required |
| INV-CLAIM-001 single-use claim | supporting | -- | required | **required** | optional | optional | -- | required |
| INV-AUTH-001 refresh rotation | supporting | -- | required | **required** | -- | -- | -- | optional |
| INV-AUTH-002 login counter | supporting | -- | required | **required** | -- | -- | -- | -- |
| INV-AUTH-003 OIDC round trip | required | -- | required | -- | -- | -- | required | required |
| INV-AUTH-004 truthful logout | supporting | -- | required | -- | -- | **required** | -- | required |
| INV-ACTIVITY-001 activity attribution | supporting | -- | **required** | -- | -- | -- | -- | -- |
| INV-PROFILE-001 allowlist | required | **required** | supporting | -- | -- | -- | -- | -- |
| INV-MCP-001 credential binding | supporting | -- | required | -- | -- | -- | -- | -- |
| INV-CURRENCY-001 currency delete | supporting | **required** | required | required | -- | -- | -- | optional |
| INV-ATTACHMENT-001 bytes present | supporting | -- | required | optional | -- | **required** | **required** | required |
| INV-BACKUP-001 backup complete | supporting | -- | required | -- | optional | **required** | **required** | required |
| INV-CRON-001 one effect per tick | supporting | -- | required | required | **required** | optional | -- | -- |
| INV-RLS-001 role privilege | supporting | -- | **required** | -- | required | -- | -- | -- |
| INV-CACHE-001 cache invalidation | required | **required** | -- | -- | -- | -- | -- | required |
| INV-RELEASE-001 one revision | required | -- | -- | -- | -- | -- | -- | workflow self-test |

Bold marks the kind that is load-bearing -- the one whose absence means the
invariant is unverified no matter how many others pass. `INV-PROFILE-001`'s is a
source scan rather than a unit test because the defect arrives via a change to a
different file: a new entity column. `INV-FX-001` and `INV-HOLDING-002` need
scans for the same reason -- both are scattered across call sites, and every
previous fix corrected one and left the others.

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

**That job can currently pass having run nothing.** `test:integration` carries an
unconditional `--passWithNoTests`, so a renamed directory or an edited
`testPathPatterns` regex turns a discovery failure into a green check across all
six kinds at once. `docs/release-integrity.md` REL-001 and REL-002 cover this;
it is repeated here because the consequence is a verification consequence, not
merely a CI hygiene one. There are 21 suites under
`backend/test/integration/` today, and nothing asserts that number does not
shrink.

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

### Located in the current suites

These were found by reading the suites, and each is cited so it can be checked
rather than taken on trust. Correcting the invariant means correcting these in
the same change.

| Test | Asserts | Protects the violation of |
| --- | --- | --- |
| `backend/src/net-worth/net-worth.service.spec.ts` around lines 516 and 2664 | Additive stock-split replay. The comment spells the arithmetic out: `95 - TRANSFER_OUT 5 + SPLIT 90 = 180 shares`, and a second case `BUY 100, SELL 30, TRANSFER_OUT 20, SPLIT 50 = 100 shares`. Under the correct multiplicative rule a SPLIT row of 90 applied to 90 shares is 8,100, not 180. | INV-HOLDING-002 |
| `frontend/src/components/settings/BackupRestoreSection.test.tsx`, `frontend/src/components/settings/DangerZoneSection.test.tsx`, `backend/src/users/users.service.spec.ts`, `backend/src/backup/backup.service.spec.ts` | `oidcIdToken: 'oidc-session-confirmed'` accepted as proof of re-authentication. | INV-AUTH-003 |

The second is the clearest case of the category: the sentinel string is asserted
on both sides, so the tests do not merely tolerate the defect -- they specify it.
Implementing a real OIDC round trip must change them, and that friction is what
makes the defect look like a decision.

The first is the more instructive one. It reads as a careful test: five actions,
three months, arithmetic worked out in a comment. The arithmetic is simply the
wrong rule, applied consistently. A reviewer checking whether the code matches
the test would find that it does.

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

### The scans this document requires do not exist yet

Section 3 marks a source scan as load-bearing for INV-FX-001, INV-HOLDING-002,
INV-PROFILE-001, INV-CURRENCY-001 and INV-CACHE-001. **None of them is written.**
Each would be a handful of lines in the pattern of
`frontend/src/test/ui-conventions.test.ts`:

| Scan owed | Fails on |
| --- | --- |
| FX fallback | a `: 1` else-branch beside a rate lookup, or `?? amount` beside a conversion |
| Share replay | a `SPLIT` case outside the single shared reducer |
| Profile response | an entity column absent from the response allowlist |
| Currency references | an FK to `currency_code` in `schema.sql` that the in-use check does not cover |
| Cache families | a cache prefix in `src/` that declares itself neither transaction-derived nor reference data |

They are not written here because each would fail immediately against `main` --
the defects they scan for are present, which is the point of the scan. A guard
introduced in the same change that fixes its violations is verifiable; one
introduced alone either breaks the suite or has to be born with a
baseline-exception list, which is a decision about how much known-wrong code to
bless and belongs to whoever fixes the underlying invariant.

That is a reason for sequencing, not an excuse. Until these exist, INV-FX-001 and
INV-HOLDING-002 in particular are guarded only by prose, and both have already
been fixed at one call site while siblings stayed live.

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
