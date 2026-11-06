# Spec: an exchange-rate pair is stored in one orientation

Proposed specification for collapsing `exchange_rates` from two rows per pair
and date -- the fetched direction and its synthesised mirror -- to one row in a
canonical orientation, with every reader taking either direction through the one
resolver. Written before the implementation, per
`docs/financial-calculation-contract.md` section 9 and `AGENTS.md` ("a financial
feature of any substance starts from a short approved spec"). The staged plan is
`docs/future-plans/exchange-rate-canonical-orientation.md` and its task list is
`docs/future-plans/exchange-rate-canonical-orientation-tasks.md`.

**Status: approved.** The maintainer answered section 11 on 2026-09-19, choosing
the full collapse over the smaller "make the latest-rate lookup inverse-aware and
leave the mirror rows alone", and took the recommendation on every other
question. Those answers are part of the specification; section 11 records them.

This spec governs *how a stored rate is oriented and how a lookup reads it*. It
does not change the age bound (`FX_MAX_RATE_AGE_DAYS`), the look-ahead rule, the
provider fetch, the stored precision, or the direction of a transaction's own
`exchange_rate` column (`docs/financial-semantics.md` section 3). It builds on
INV-FX-001 and `docs/time-series-contract.md` section 2.2.

## 1. What this changes, and why

Every provider fetch is persisted twice today. `saveRate` writes `from -> to`
and then `roundFxRate(1 / rate)` as `to -> from` in one transaction;
`persistRateSeries` does the same for every day of a fetched window. The Money
importer writes the one orientation the file recorded and synthesises nothing.

The mirror exists because two readers are direction-specific --
`ExchangeRateService.getLatestRate` and the coverage probe inside
`backfillHistoricalRates` -- while the newer read path (`resolveFxRate`) already
consults both directions and inverts the reverse observation itself.

The cost that matters is **drift**. A one-sided upsert, such as an import
overwriting `CAD -> USD` on a date the provider wrote both, leaves the two rows
no longer reciprocal. The resolver's rule (the more recently observed direction
wins, a tie goes to direct) then makes the answer for a date depend on which row
happens to be newer, so two figures in one report can disagree, and no guard
sees it.

The change: **one canonical orientation per pair, written by one helper, every
lookup inverse-aware.** The mirror row is no longer written; rows already
holding both orientations are collapsed by a later contract migration, after
which a `CHECK` makes a second orientation impossible to store.

## 2. Definitions

- **Pair.** Two distinct ISO 4217 codes. `USD -> USD` is not a pair and is never
  stored; `resolveFxRate` answers 1 for it without a lookup (INV-FX-001).
- **Canonical orientation.** The one whose `from_currency` sorts before its
  `to_currency` in plain code-point order (`"CAD" < "USD"`), which is the order
  `directionlessPairKey` already sorts by. A pair with exactly one coin side is
  the exception, stored coin -> fiat (section 12). It is user-independent, which a
  "foreign to reporting currency" rule could not be on a table every user
  shares.
- **`canonicalRateRow(from, to, rate)`**
  (`backend/src/currencies/canonical-rate.util.ts`). Returns the row to store:
  the input unchanged when it is already canonical; the codes swapped and the
  rate replaced by `roundFxRate(1 / rate)` when it is not; `null` for equal
  codes or a non-positive or non-finite rate. It is the only way a row reaches
  `INSERT INTO exchange_rates`.
- **Inverse-aware.** A lookup for `from -> to` that consults the stored rows of
  both `(from, to)` and `(to, from)` and inverts the second. `resolveFxRate`
  (`backend/src/common/time-series/fx-rate-resolver.ts`) is the one place that
  decides between them; a caller never restates the decision.

## 3. Invariants

### INV-FX-003 -- a pair is stored in one orientation

For every pair and `rate_date` there is at most one row in `exchange_rates`, and
its `from_currency` sorts before its `to_currency`.

The mechanism arrives in two releases.

1. **Expand (this PR).** Every writer routes through `canonicalRateRow`, and a
   source scan
   (`backend/src/currencies/exchange-rate-orientation.guard.spec.ts`) fails an
   `INSERT INTO exchange_rates` in any file that is not one of the two reviewed
   writers or that does not reference the helper. Status **partial**: rows
   written before this release still hold both orientations, and nothing in the
   database refuses a second one.
2. **Contract (a later PR, after this release is rolled out).** A data migration
   inserts an inverted copy of every non-canonical row for which no canonical
   row exists on that date, deletes every non-canonical row, and adds
   `CHECK (from_currency < to_currency)`. Status **enforced**: the constraint is
   the mechanism.

The split is what `docs/database-migrations.md` requires -- expand first,
contract in a later release. During a rolling deployment the previous release's
pods still write the mirror row and still read one direction, so the `CHECK` and
the delete must wait until no such pod exists. In the expand release those pods
keep working, because the mirror rows they rely on are still present and a
day-old rate is what they already tolerate.

### INV-FX-001: unchanged rule, one more reader inside the door

`getLatestRate` becomes a read through `resolveFxRate` in `live` mode: the
newest row of each direction, chosen by the same rule as every other lookup. Its
age bound stays optional -- a caller passes `maxAgeDays`, and omitting it means
no bound, as today -- so the only behavioural change is that a pair stored the
other way is now found. Bounding the dateless posting fallbacks is a
posting-policy decision that the one-door guard's baseline records as separate,
and it stays separate.

### What does NOT become a new invariant

- **The precision of an inverted rate.** `roundFxRate(1 / rate)` at ten decimals
  round-trips to within 1e-9 of the fetched rate (section 6). That is already
  the precision every inverse lookup used; storing the canonical side rather
  than the fetched side changes which figure carries the rounding, not its size.
- **Which orientation the provider is asked for.** The fetch still tries the
  symbol as named and then its reverse. Only what is stored is canonicalised.

## 4. Truth tables

### `canonicalRateRow(from, to, rate)`

| `from` | `to` | `rate` | Result |
|---|---|---|---|
| `CAD` | `USD` | 0.7143 | `{ CAD, USD, 0.7143 }`, unchanged |
| `USD` | `CAD` | 1.4 | `{ CAD, USD, 0.7142857143 }`, swapped and inverted at 10dp |
| `USD` | `USD` | 1 | `null`, not a pair |
| `USD` | `CAD` | 0 | `null`, absent rather than applicable (INV-FX-001) |
| `USD` | `CAD` | -1.4 | `null` |
| `USD` | `CAD` | `NaN` or `Infinity` | `null` |

### `getLatestRate(from, to, maxAgeDays?)` through `resolveFxRate` in `live` mode

`D` is the newest stored `from -> to` row, `I` the newest `to -> from` row.

| Stored | Answer |
|---|---|
| neither | `null` |
| `D` only | `D.rate` |
| `I` only | `1 / I.rate` |
| both, `I` observed later | `1 / I.rate` |
| both, `D` observed on or after `I`'s date | `D.rate`, a tie going to direct |
| `D` outside `maxAgeDays`, `I` inside it | `1 / I.rate` |
| both outside `maxAgeDays` | `null` |
| `from` equals `to` | 1, without a query |
| a stored rate at or below 0 | that row is absent, not applicable |

The rows where both directions exist describe a database written before the
contract migration. After it, exactly one of `D` and `I` can exist. The specs
assert the whole table, because that is the data the expand release runs on.

### Writers

| Writer | Input | Row stored |
|---|---|---|
| `saveRate`, the daily refresh | `USD -> CAD` at 1.4 | one row, `CAD -> USD` at 0.7142857143 |
| `saveRate` | `CAD -> USD` at 0.72 | one row, `CAD -> USD` at 0.72 |
| `persistRateSeries`, a window fetch | `EUR -> PLN` over two days | two rows, `EUR -> PLN`, one per day |
| `writeExchangeRates`, a Money import | `USD -> GBP` at 0.79 recorded | one row, `GBP -> USD` at 1.2658227848, source `mny_import` |
| `writeExchangeRates` | both orientations recorded for one date | one row; the later file row wins, as before |

## 5. Missing-data policy

Unchanged from INV-FX-001 and `docs/financial-calculation-contract.md` section
1.3. A pair with no admissible row in either direction is `null`, never 1 and
never the unconverted amount, and a resolution names its reason
(`no_observation`, `stale_observation`, `only_after_date`).

Making the latest-rate lookup inverse-aware turns three `null`s that were
artefacts of orientation into answers: the investment posting fallback, the
scheduled-estimate refresh, and a rate entered against no posting date. It
creates no new way for a figure to be unknown.

## 6. Numerical examples

Inverting with `roundFxRate` at `NUMERIC(20,10)`:

| Fetched | Stored inverse | Inverted back | Error |
|---|---|---|---|
| 1.3652 | 0.7324934076 | 1.3651999999 | 1.0e-10 |
| 1.4 | 0.7142857143 | 1.4 | 0 |
| 4.25 | 0.2352941176 | 4.2500000009 | 9.0e-10 |
| 0.79 | 1.2658227848 | 0.79 | 0 |

On a 10,000 USD amount the largest error above moves the converted figure by
less than 0.00001 CAD, three orders of magnitude below the cent `roundMoney`
keeps. The reason the column is ten decimals rather than money precision still
holds: 1 / 1.3652 rounded to four places is 0.7325, which inverts back to
1.3661.

## 7. Concurrency and idempotency

Nothing new. The write is the existing single-statement upsert on
`UNIQUE(from_currency, to_currency, rate_date)`, mechanism 4 of
`docs/concurrency-and-idempotency.md`. Two replicas refreshing the same pair on
the same day still converge, now on one row instead of two. The importer dedupes
before its multi-row `INSERT` on the canonical triple, so a file recording a
pair both ways for one date cannot put the same key in one `VALUES` list twice,
which is the error the existing price dedupe exists to avoid.

## 8. What changes outside the writers

- `getLatestRate` reads both directions and returns what `resolveFxRate` chose.
- `convertOnDate` drops its own reverse chase. `resolveFxRateOrNull` already
  resolves both directions, so the chase was dead code.
- The coverage probe in `backfillHistoricalRates` asks whether the pair has any
  row in either direction, the way `readCoverage` already does. Otherwise a pair
  stored canonically as `default -> foreign` reads as uncovered and is re-fetched
  from the provider on every run.
- `GemPositionService.convert` makes one lookup instead of a direct-then-reverse
  pair, and leaves the reciprocal allowlist in
  `backend/src/common/fx-fallback.guard.spec.ts`, which is shrink-only.
- The client rate map (`frontend/src/hooks/useExchangeRates.ts`) and the
  server-side map in `backend/src/built-in-reports/report-currency.service.ts`
  already fall back to the inverse key, so receiving one orientation per pair
  needs no change in either. (Correction, audit A26-H11: they fall back only
  when the direct key is absent, and a database upgraded from before this
  release still holds the frozen mirror row, so both took it over the fresh
  canonical row. `ExchangeRateService.getLatestRates` now answers one row per
  pair, the newer direction inside `FX_MAX_RATE_AGE_DAYS`, and the client map
  keeps the newer orientation and drops a row older than the bound.) Coverage `observations` counts distinct dates and
  is unchanged; so is the day count a history extension reports.

## 9. Staging

| Release | Ships | The previous release's pods during the rollout |
|---|---|---|
| PR 1, expand | canonical writers, inverse-aware readers, the orientation guard, this spec, the plan | write mirror rows, which are harmless duplicates the contract migration removes, and read one direction, which the mirror rows still satisfy |
| PR 2, contract | the data migration, `database/schema.sql`, INV-FX-003 to `enforced` | are PR 1 pods: canonical writers and inverse-aware readers, so the `CHECK` refuses nothing they write |

PR 2 is authored after PR 1 is deployed everywhere it will be, taking its
timestamp prefix at authoring time. Its migration is idempotent by predicate:
the insert is `ON CONFLICT DO NOTHING`, the delete's `WHERE from_currency >
to_currency` matches nothing on a second pass, and the constraint is dropped
`IF EXISTS` before it is added.

### The migration's conflict rule

Where both orientations exist for one date and are not reciprocal, **the
canonical row wins**. Both rows carry the same `source` when both came from the
provider, so a synthesised mirror cannot be told from a fetched row after the
fact; a deterministic one-statement rule was preferred to a `created_at` race or
a ranking over `source`. A user who imported a Money file over provider data and
wants the file's figure re-imports it: the importer upserts and wins on
conflict, as it does today.

## 10. Test matrix

| Claim | Where | Kind |
|---|---|---|
| the `canonicalRateRow` truth table | `canonical-rate.util.spec.ts` | unit |
| `saveRate` issues one upsert, canonical, for an input given the other way | `exchange-rate.service.spec.ts` | unit |
| `persistRateSeries` writes one canonical row per day | `exchange-rate.service.spec.ts` | unit |
| a fetch answered only by the reverse symbol stores one canonical row | `exchange-rate.service.spec.ts` | unit |
| `writeExchangeRates` canonicalises, and dedupes on the canonical triple | `write-prices.spec.ts` | unit |
| the `getLatestRate` truth table: inverse only, later inverse, tie, bound on both sides, non-positive | `exchange-rate.service.spec.ts` | unit |
| `convertOnDate` resolves an inverse-only pair with one lookup and no second call | `exchange-rate.service.spec.ts` | unit |
| the backfill probe counts a pair stored the other way as covered | `exchange-rate.service.spec.ts` | unit |
| GEM converts with one lookup and stays `null` when the pair is unknown | `gem-position.service.spec.ts` | unit |
| no `INSERT INTO exchange_rates` outside the two writers, each naming the helper, and the scanner fails a fixture without it | `exchange-rate-orientation.guard.spec.ts` | guard |
| the reciprocal allowlist no longer names GEM, and would fail a reintroduced reciprocal there | `fx-fallback.guard.spec.ts` | guard |
| the one-door baseline is unchanged in both directions | `fx-rate.one-door.spec.ts` | guard |
| coverage over a reverse-only pair still resolves, which is pre-migration data | `fx-rate-coverage.integration.spec.ts` | integration |
| PR 2: both reciprocal; both disagreeing, canonical surviving; non-canonical only, an inverted copy appearing; a re-run changing nothing; the `CHECK` refusing a non-canonical insert | a migration spec shaped like `migration-149-backfill.integration.spec.ts` | integration, PR 2 |

## 11. Decisions (answered 2026-09-19)

| # | Question | Decision |
|---|---|---|
| 1 | The smaller fix, keeping the mirror rows, or the full collapse? | **The full collapse.** |
| 2 | Which canonical orientation? | **Lexicographic**, `from_currency < to_currency`, the order `directionlessPairKey` already uses. |
| 3 | How is it staged? | **Two PRs**, expand then contract, per `docs/database-migrations.md`. |
| 4 | Which row survives when both orientations disagree on a date? | **The canonical row.** |
| 5 | What does the Money importer do? | **Canonicalises on import**, inverting with `roundFxRate`, one row per pair and date. |
| 6 | GEM's own direct-then-reverse pair? | **Collapsed to one lookup**; the reciprocal allowlist shrinks. |
| 7 | The default age bound on the latest-rate lookup? | **Unchanged, unbounded.** A separate posting-policy decision. |

## 12. Addendum (2026-11-05): a coin pair is stored coin first

Cryptocurrencies (`docs/specs/crypto-accounts.md`) broke the assumption behind
section 6: that the inverse of a rate keeps its significant figures at ten
decimals. A coin is worth many units of a fiat, so its fiat -> coin rate is
tiny. `XBT -> IDR` at 1.52e9 sorts as `IDR -> XBT` by code, stored at ten
decimals as `0.0000000007`, which resolves back to 1.43e9: 6% off.

**The rule.** `isCanonicalOrientation(from, to, isCoin)` stores a pair with
exactly one CRYPTO side (`currencies.kind`) coin -> fiat, whichever code sorts
first. Two fiats, or two coins, keep plain code order (section 2). `isCoin`
defaults to "nobody is a coin", so a caller without a kind lookup gets the
section 2 rule unchanged; `BTC -> EUR` is canonical under both, because BTC
sorts first and is the coin.

**Who passes the lookup.** Every writer reads `currencies.kind` once per
operation and passes it to `canonicalRateRow`: the daily and weekend refresh
from the kinds `currenciesInUse` already reads (`saveRate`, and
`canonicalPairsByBase`, which groups each pair under the code it is stored
under, so a coin that sorts after its fiats is one question under the coin);
`persistRateSeries` (and so `storeRateSeries` and every window fill) through
`loadCoinLookup` on its own transaction's manager; the Money importer's
`writeExchangeRates` the same way. `getLatestRates` breaks a same-day tie
towards the coin-first row. There is no manual-rate writer of
`exchange_rates`.

**Out of range.** `canonicalRateRow` returns `null` for a rate that, as
stored, would be at or above 1e10 (`NUMERIC(20,10)` overflows and the whole
statement fails) or rounds to zero at ten decimals (`canonicalRateRefusal`
names the reason `out_of_range`). The refresh reports that one pair as "Rate
out of range" and saves the rest; a window skips the point and logs a count;
the importer drops the row like any other unusable one. `BTC -> LBP` at 1.1e10
is the example.

**What stays code-ordered.** `exchange_rate_coverage` keys a pair in plain code
order (its CHECK is `from_currency < to_currency`), and so does
`directionlessPairKey` (`codeOrderedPair`). A coverage row and a pair key
answer "which pair", not "which direction is stored": a window covers both
directions, and a key that followed `currencies.kind` would break the coverage
CHECK for a coin that sorts after its fiat and orphan the row if a code's kind
changed.

**The contract release.** Section 3's `CHECK (from_currency < to_currency)` on
`exchange_rates` can no longer be the mechanism: a coin-first row such as
`XBT -> IDR` violates it, and a CHECK cannot read `currencies.kind`. The
contract migration needs a rule that can (a trigger, or a check through an
immutable function over a kind snapshot), and its data step must orient by the
same rule. Until it is redesigned INV-FX-003 stays `partial`.

**Precision, restated.** Section 3's "within 1e-9" is an absolute bound for a
fiat rate. Stored coin first, a coin pair keeps every figure the provider sent
in the stored direction, and the inverse `resolveFxRate` computes is exact to
floating point: `IDR -> XBT` from a stored `XBT -> IDR` 1.52e9 is within 1e-9
relative of `1 / 1.52e9`.

Tests: `canonical-rate.util.spec.ts` ("the coin rule", "a rate the column
cannot hold", `codeOrderedPair`), `exchange-rate.service.spec.ts` (a coin window
stored coin first with one kind read, the refresh's coin base and out-of-range
report, the `getLatestRates` tie), `write-prices.spec.ts` (an import of
`IDR -> XBT` stored `XBT -> IDR`).
