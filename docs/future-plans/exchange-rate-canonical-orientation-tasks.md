# Canonical Exchange-Rate Orientation: Agent Task List

The task graph for `docs/future-plans/exchange-rate-canonical-orientation.md`.
The invariants are `docs/specs/exchange-rate-canonical-orientation.md`; the
maintainer's decisions are the table in the plan.

## How to use this list (read first, every session)

- **One task per session/PR.** Each task names the files it may touch. Touching
  files outside that scope is a scope violation; split it into its own task.
- **Name INV-FX-003 and INV-FX-001 in every PR**, and link the issue.
- **T2 must not be authored until T1 is deployed everywhere it will be.** It is a
  contract migration: authoring it early puts a `CHECK` in the tree that the
  previously deployed release violates on every write. If you are unsure whether
  T1 is deployed, ask the maintainer rather than guessing.

## Definition of done for every task

- `npm run lint && npx tsc --noEmit && npm run typecheck` clean (backend).
- `TZ=UTC npm run test:unit -- --coverage` at or above the layer thresholds.
- `npm run build && npm run test:integration` when a query, an entity or a
  migration changed.
- A migration is mirrored into `database/schema.sql` in the same commit;
  `npm run migration:lint`, `scripts/verify-schema.sh` and
  `node scripts/check-migration-prefixes.mjs` pass.
- A new or changed invariant is in **both** `docs/system-invariants.md` and
  `docs/verification-contract.md` section 3.
- New files staged (`git add -N`) before running the tree-walking guard specs.
- No guard baseline grows. The reciprocal allowlist and the one-door baseline
  shrink or stay the same.

## Task graph

| ID | Task | Depends on | Deploy impact | Status |
| --- | --- | --- | --- | --- |
| T1 | The expand release: `canonicalRateRow` plus spec; `directionlessPairKey` on the same comparison; `saveRate` and `persistRateSeries` write one canonical row; the Money importer canonicalises and dedupes; `getLatestRate` reads both directions through `resolveFxRate`; `convertOnDate` drops its reverse chase; the backfill coverage probe becomes directionless; GEM makes one lookup; the orientation guard; the reciprocal allowlist shrinks; docs. Files: `backend/src/currencies/*`, `backend/src/import/mny/writers/write-prices.ts`, `backend/src/strategies/gem-position.service.ts`, `backend/src/common/fx-fallback.guard.spec.ts`, `backend/src/common/time-series/fx-rate.one-door.spec.ts`, `backend/CLAUDE.md`, `docs/*`. Invariants: INV-FX-003 (partial), INV-FX-001. | -- | no migration; mirror rows stop being written | [x] (8efbd927a, 2026-09-19) |
| T2 | The contract release: the data migration, `schema.sql`, the `CHECK`, its integration spec, INV-FX-003 to `enforced`, and the doc lines that describe the pre-collapse tie-break. Files: `database/migrations/<new>`, `database/schema.sql`, `backend/test/integration/*`, `docs/*`. Invariant: INV-FX-003 (enforced). | T1 **deployed** | deletes rows, adds a `CHECK` | [ ] |

## T2 in full

Everything a fresh session needs. Read `database/CLAUDE.md` and
`docs/database-migrations.md` first.

**The file.** `database/migrations/YYYYMMDDHHMMSS_description.sql`, named
`exchange_rates_canonical_orientation`, the prefix being the UTC second you
author it (`date -u +%Y%m%d%H%M%S`). Never a sequential number.

**Statement 1, the inverted copies.** For every non-canonical row with no
canonical row on that date, insert the inverted row. `ON CONFLICT DO NOTHING`
implements the conflict rule from spec section 9: where a canonical row already
exists it is kept, whatever the non-canonical row says.

```sql
INSERT INTO exchange_rates (from_currency, to_currency, rate, rate_date, source)
SELECT to_currency, from_currency, ROUND(1 / rate, 10), rate_date, source
  FROM exchange_rates
 WHERE from_currency > to_currency
   AND rate > 0
ON CONFLICT (from_currency, to_currency, rate_date) DO NOTHING;
```

`ROUND(1 / rate, 10)` is `roundFxRate` in SQL: the column is `NUMERIC(20,10)`
and the application rounds to ten places. A row with a non-positive rate is
absent rather than applicable (INV-FX-001), so it is not inverted; statement 2
deletes it with the rest.

**Statement 2, the delete.** Self-excluding, so a second pass matches nothing.

```sql
DELETE FROM exchange_rates WHERE from_currency > to_currency;
```

**Statement 3, the constraint.** Dropped first, because PostgreSQL has no
`ADD CONSTRAINT IF NOT EXISTS`; this is the recipe in
`docs/database-migrations.md`.

```sql
ALTER TABLE exchange_rates
    DROP CONSTRAINT IF EXISTS chk_exchange_rates_canonical_orientation;
ALTER TABLE exchange_rates
    ADD CONSTRAINT chk_exchange_rates_canonical_orientation
    CHECK (from_currency < to_currency);
```

A row where either code is `NULL` makes the `CHECK` evaluate to unknown, which
passes; both columns are nullable and no writer produces a null code, so this is
noted rather than tightened. Adding `NOT NULL` is a separate expand-contract
step.

**Note (2026-11-05): the `CHECK` above no longer holds as written.** The crypto
work stores a pair with exactly one coin side coin first, whatever the code
order (`docs/specs/exchange-rate-canonical-orientation.md` section 12
addendum): `XBT -> IDR` is canonical although `IDR` sorts first. Statement 3 as
written would reject those rows, and statements 1 and 2 would invert and delete
them. Before T2 is authored the rule must either exclude every pair with a
`CRYPTO` side (`currencies.kind`) from the `CHECK` and from statements 1 and 2,
or be replaced by a trigger that reads `currencies.kind`; a `CHECK` cannot read
another table.

**`schema.sql`.** Add the same constraint to the `exchange_rates` table
definition in the same commit, so a fresh install matches a migrated database
and `scripts/verify-schema.sh` replays clean.

**The integration spec.** Shaped like
`backend/test/integration/migration-149-backfill.integration.spec.ts`, which
reads the migration file from disk and runs it against real rows, because the
assertion is about what a SQL predicate concludes. Cases:

1. both orientations present and reciprocal: one row survives, canonical, same
   rate;
2. both present and disagreeing: the canonical row survives unchanged, and the
   non-canonical rate is not written anywhere;
3. non-canonical only: an inverted canonical copy appears, at ten decimals, with
   the original `source`;
4. a non-canonical row with a rate of 0: deleted, and no inverted copy;
5. re-running the whole file changes nothing (the idempotency claim);
6. after the migration, inserting a non-canonical row is refused by the
   constraint.

**Docs to update in T2.**

- `docs/system-invariants.md`: INV-FX-003 to `enforced`, naming the constraint as
  the mechanism, in the index row and the body.
- `docs/verification-contract.md` section 3: the INV-FX-003 row gains its
  integration requirement.
- `docs/specs/fx-conversion-completeness.md`: the "direct or inverse, whichever
  observed the date more recently" line describes data that no longer exists in
  two orientations. Add a dated note that the tie-break is now unreachable for
  stored rows; do not rewrite the approved text.
- `docs/specs/exchange-rate-canonical-orientation.md`: the truth-table rows for
  "both directions stored" become historical. Add a dated note; the spec is a
  record of what was decided.
- `backend/test/integration/fx-rate-coverage.integration.spec.ts` inserts a
  reverse-only pair on purpose. After the `CHECK` it must insert the canonical
  orientation instead, or assert the refusal; decide which and say so in the PR.

**What T2 must not do.** Rename or edit an already-merged migration; add
`NOT NULL` to either currency column; touch the age bound; change `source`
semantics; or widen any guard baseline.
