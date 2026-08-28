import { readFileSync } from "fs";
import { join } from "path";

/**
 * An occurrence's identity is a recurrence slot, and the constraint that
 * enforces it has to be the one the code names.
 *
 * The table's uniqueness used to name `override_date` while every read, the
 * refusal in `createOverride`, `docs/financial-semantics.md` and a comment in
 * the expander all said `original_date`. Nothing failed: the constraint was
 * real, the claims were plausible, and the disagreement only showed up as two
 * overrides replacing one occurrence with row order deciding which one posted.
 *
 * So the check is not "is there a unique constraint" -- there was -- but "does
 * it cover the columns the code keys on, and does the code name it correctly".
 */
const repoRoot = join(__dirname, "..", "..", "..");

const read = (relative: string): string =>
  readFileSync(join(repoRoot, relative), "utf8");

/** The constraint name the service translates a 23505 on. */
const CONSTRAINT = "uq_sched_txn_overrides_occurrence";

describe("the override occurrence-identity constraint", () => {
  const schema = read("database/schema.sql");
  const overridesTable = (() => {
    const start = schema.indexOf(
      "CREATE TABLE scheduled_transaction_overrides",
    );
    expect(start).toBeGreaterThan(-1);
    const end = schema.indexOf("\n);", start);
    expect(end).toBeGreaterThan(start);
    return schema.slice(start, end);
  })();

  it("is unique on the recurrence slot, under the name the service matches", () => {
    expect(overridesTable).toMatch(
      new RegExp(
        `CONSTRAINT\\s+${CONSTRAINT}\\s+UNIQUE\\s*\\(\\s*scheduled_transaction_id\\s*,\\s*original_date\\s*\\)`,
        "s",
      ),
    );
  });

  it("does not also constrain the moved date", () => {
    // Two different occurrences of one schedule moved onto the same day is
    // ordinary (pay the 1st and the 15th together on the 10th). Under the old
    // constraint that was a raw 500 from the driver, and nothing reads by
    // `override_date` as a key, so its uniqueness bought nothing.
    expect(overridesTable).not.toMatch(
      /UNIQUE\s*\(\s*scheduled_transaction_id\s*,\s*override_date\s*\)/,
    );
  });

  it("is the name the service translates a unique violation on", () => {
    // Matching by name is what keeps the message honest: a violation of some
    // other constraint on this table must not be reported as "you already have
    // an override for that occurrence".
    const service = read(
      "backend/src/scheduled-transactions/scheduled-transaction-override.service.ts",
    );
    expect(service).toContain(`"${CONSTRAINT}"`);
    expect(service).toContain('"23505"');
  });

  it("has a migration that replays as a no-op", () => {
    // `ADD CONSTRAINT IF NOT EXISTS` does not exist, so the migration drops
    // first -- the same idiom migration 165 uses. `migration:lint` enforces this
    // repo-wide; asserted here too because a constraint that fails to attach on
    // replay aborts container start-up and surfaces only as "backend exited (1)".
    const migration = read(
      "database/migrations/167_override_occurrence_identity.sql",
    );
    expect(migration).toContain(`DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
    expect(migration).toContain(`ADD CONSTRAINT ${CONSTRAINT}`);
    // The old constraint is found by its columns, not by a guessed truncation of
    // the name PostgreSQL generated.
    expect(migration).toContain("pg_constraint");
    expect(migration).not.toMatch(
      /DROP CONSTRAINT IF EXISTS scheduled_transaction_overrides_scheduled/,
    );
  });

  it("drops the plain index the constraint's own index replaces", () => {
    // Two indexes on the same columns cost every write twice and answer nothing
    // extra, so the schema must not still declare the old lookup index.
    expect(schema).not.toContain("idx_sched_txn_overrides_orig");
    expect(
      read("database/migrations/167_override_occurrence_identity.sql"),
    ).toContain("DROP INDEX IF EXISTS idx_sched_txn_overrides_orig");
  });
});
