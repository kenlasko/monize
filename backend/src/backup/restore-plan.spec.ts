import { readFileSync } from "fs";
import { join } from "path";
import {
  CONFLICT_ARBITER_COLUMNS,
  DEFERRED_FK_COLUMNS,
  DEFERRED_FK_REPAIRS,
  PRESERVED_ON_RESTORE,
  RESTORABLE_TABLES,
  RESTORE_PLAN,
} from "./restore-plan";
import {
  parseForeignKeys,
  readSchema,
  SCHEMA_PATH,
} from "./__fixtures__/schema-foreign-keys";

/**
 * Proves the restore's insertion order against the real schema.
 *
 * A restore inserts row by row into tables with immediate foreign keys, so a
 * column pointing at a row that does not exist yet aborts the transaction and
 * rolls the whole restore back. Whether that can happen is a property of three
 * declarations in `restore-plan.ts` and the foreign keys in
 * `database/schema.sql` -- so it is checked here rather than trusted to whoever
 * next adds a column.
 *
 * `accounts.linked_loan_account_id` is why: a self-referential FK added by
 * migration 093 that nobody added to the deferred list. Any user who linked a
 * property to the mortgage financing it held a backup that could not be
 * restored, and the failure was invisible until the restore ran, because the
 * export succeeded and the file was valid.
 */

const foreignKeys = parseForeignKeys(readSchema());
const insertPosition = new Map(
  RESTORE_PLAN.map((step, index) => [step.table, index]),
);
const deferredKey = (table: string, column: string) => `${table}.${column}`;
const deferred = new Set(
  Object.entries(DEFERRED_FK_COLUMNS).flatMap(([table, columns]) =>
    columns.map((column) => deferredKey(table, column)),
  ),
);
const repaired = new Set(
  DEFERRED_FK_REPAIRS.map((repair) => deferredKey(repair.table, repair.column)),
);

describe("restore plan", () => {
  // The rest of this file trusts the parser. A regex that silently stops
  // matching turns every assertion below into a vacuous pass, so the parser is
  // checked against known-present foreign keys and a floor count first.
  describe("schema foreign-key parser", () => {
    it("finds foreign keys of all three declaration styles", () => {
      const has = (table: string, column: string, referencedTable: string) =>
        foreignKeys.some(
          (fk) =>
            fk.table === table &&
            fk.column === column &&
            fk.referencedTable === referencedTable,
        );

      // Column-level REFERENCES.
      expect(has("accounts", "user_id", "users")).toBe(true);
      // Column-level self-reference.
      expect(has("categories", "parent_id", "categories")).toBe(true);
      // Table-level FOREIGN KEY (...) constraint.
      expect(has("transaction_tags", "transaction_id", "transactions")).toBe(
        true,
      );
      // ALTER TABLE ... ADD CONSTRAINT, used for the forward references.
      expect(has("accounts", "linked_loan_account_id", "accounts")).toBe(true);
      expect(
        has("accounts", "scheduled_transaction_id", "scheduled_transactions"),
      ).toBe(true);
    });

    it("parses the whole schema, not a fragment of it", () => {
      // Well below today's count; a parser that broke would return far fewer.
      expect(foreignKeys.length).toBeGreaterThan(100);
    });
  });

  describe("insertion order", () => {
    it("inserts every table after the tables it references", () => {
      const violations = foreignKeys
        .filter((fk) => {
          const from = insertPosition.get(fk.table);
          const to = insertPosition.get(fk.referencedTable);
          // Only restored-to-restored edges constrain the order. An edge into
          // users or currencies is satisfied before the restore begins.
          if (from === undefined || to === undefined) return false;
          const pointsForwardOrAtItself = to >= from;
          return (
            pointsForwardOrAtItself &&
            !fk.initiallyDeferred &&
            !deferred.has(deferredKey(fk.table, fk.column))
          );
        })
        .map(
          (fk) =>
            `${fk.table}.${fk.column} -> ${fk.referencedTable} ` +
            `(inserted at ${insertPosition.get(fk.table)}, target at ${insertPosition.get(fk.referencedTable)})`,
        );

      // Each of these would abort the restore transaction on the first row that
      // used the column. Add the column to DEFERRED_FK_COLUMNS and
      // DEFERRED_FK_REPAIRS, or move the table later in RESTORE_PLAN.
      expect(violations).toEqual([]);
    });
  });

  describe("deferred foreign keys", () => {
    it("repairs every column it strips", () => {
      const strippedButNeverRepaired = [...deferred].filter(
        (key) => !repaired.has(key),
      );
      // A stripped column that is never re-applied silently drops the link:
      // the restore succeeds and the user's data comes back with the reference
      // missing, which is worse than the failure it was avoiding.
      expect(strippedButNeverRepaired).toEqual([]);
    });

    it("strips every column it repairs", () => {
      const repairedButNeverStripped = [...repaired].filter(
        (key) => !deferred.has(key),
      );
      expect(repairedButNeverStripped).toEqual([]);
    });

    it("names only columns that are really foreign keys", () => {
      const notAForeignKey = [...deferred].filter((key) => {
        const [table, column] = key.split(".");
        return !foreignKeys.some(
          (fk) => fk.table === table && fk.column === column,
        );
      });
      // A renamed or dropped column left in the list means the restore strips a
      // column that no longer exists and repairs nothing.
      expect(notAForeignKey).toEqual([]);
    });

    it("confines every repair to the restoring user's rows", () => {
      // The Phase-3 UPDATE is keyed by an id from the uploaded file. On a table
      // with its own user_id it is scoped by `user_id = $3`; on one without, it
      // has to name the user-scoped parent that says whose row it is, or the
      // UPDATE writes whichever user's row carries that id.
      const scoped = new Map(
        RESTORE_PLAN.map((step) => [step.table, step.scopeToUser]),
      );
      const unconfined = DEFERRED_FK_REPAIRS.filter((repair) =>
        scoped.get(repair.table)
          ? repair.ownedThrough !== undefined
          : repair.ownedThrough === undefined ||
            scoped.get(repair.ownedThrough.table) !== true ||
            !foreignKeys.some(
              (fk) =>
                fk.table === repair.table &&
                fk.column === repair.ownedThrough!.column &&
                fk.referencedTable === repair.ownedThrough!.table,
            ),
      ).map((repair) => `${repair.table}.${repair.column}`);
      expect(unconfined).toEqual([]);

      const unscopedReference = DEFERRED_FK_REPAIRS.filter(
        (repair) =>
          repair.requireReferencedTable !== undefined &&
          scoped.get(repair.requireReferencedTable) !== true,
      ).map((repair) => `${repair.table}.${repair.column}`);
      expect(unscopedReference).toEqual([]);
    });

    it("defers accounts.linked_loan_account_id", () => {
      // The regression this file exists for, asserted by name so the fix cannot
      // be removed without a test failure that says why.
      expect(deferred.has("accounts.linked_loan_account_id")).toBe(true);
      expect(repaired.has("accounts.linked_loan_account_id")).toBe(true);
    });
  });

  describe("plan shape", () => {
    it("lists each table once", () => {
      expect(RESTORE_PLAN.length).toBe(RESTORABLE_TABLES.size);
    });

    it("reports each count under the lowerCamelCase form of its table", () => {
      const toCamelCase = (table: string) =>
        table.replace(/_([a-z])/g, (_, char: string) => char.toUpperCase());
      const mismatched = RESTORE_PLAN.filter(
        (step) => step.countKey !== toCamelCase(step.table),
      ).map((step) => `${step.table} -> ${step.countKey}`);
      expect(mismatched).toEqual([]);
    });

    it("lists distinct count keys", () => {
      const keys = RESTORE_PLAN.map((step) => step.countKey);
      expect(new Set(keys).size).toBe(keys.length);
    });

    it("only forces user_id on tables that have the column", () => {
      const schema = readFileSync(SCHEMA_PATH, "utf8");
      const wrong = RESTORE_PLAN.filter((step) => {
        const block = new RegExp(
          `CREATE TABLE(?: IF NOT EXISTS)?\\s+${step.table}\\s*\\(([\\s\\S]*?)\\n\\);`,
        ).exec(schema);
        if (!block) return false;
        const hasUserId = /^\s*user_id\s/m.test(block[1]);
        return step.scopeToUser !== hasUserId;
      }).map((step) => `${step.table} (scopeToUser=${step.scopeToUser})`);
      // scopeToUser true on a table without user_id is a no-op that hides the
      // fact the rows are scoped only through their parent; false on a table
      // that has one lets a crafted backup keep a foreign user_id.
      expect(wrong).toEqual([]);
    });

    // Read once: three tests below ask what the restore actually clears, and
    // two of them are about the same fact from opposite directions.
    const cleared = new Set(
      [
        ...readFileSync(join(__dirname, "restore-wipe.ts"), "utf8").matchAll(
          /DELETE FROM (\w+) WHERE user_id/g,
        ),
      ].map((m) => m[1]),
    );

    it("pre-clears every user-scoped table before re-inserting it", () => {
      // The restore inserts with ON CONFLICT DO NOTHING, so a table not cleared
      // first keeps the destination account's existing rows and silently drops
      // the backup's -- restore-over-existing stops reproducing the artifact.
      // Every scopeToUser table therefore needs a `DELETE FROM <t> WHERE
      // user_id` in the destructive pre-clear (child tables cleared through a
      // parent are scopeToUser:false and excluded), unless it is a declared
      // exception in PRESERVED_ON_RESTORE. notification_preferences shipped
      // without one (audit / code-review Finding).
      const missing = RESTORE_PLAN.filter(
        (step) =>
          step.scopeToUser &&
          !cleared.has(step.table) &&
          !PRESERVED_ON_RESTORE.has(step.table),
      ).map((step) => step.table);
      expect(missing).toEqual([]);
    });

    it("preserves only tables that are in the plan and user-scoped", () => {
      // An entry naming a table the restore never inserts, or one whose rows
      // are scoped through a parent, would be a waiver over nothing -- and
      // would quietly excuse a real omission if that table were added later.
      const byTable = new Map(RESTORE_PLAN.map((step) => [step.table, step]));
      const wrong = [...PRESERVED_ON_RESTORE.keys()].filter(
        (table) => byTable.get(table)?.scopeToUser !== true,
      );
      expect(wrong).toEqual([]);
    });

    it("gives every preserved table a reason", () => {
      // The waiver is the argument, not the entry: a blank one is a table
      // nobody has to justify keeping out of the pre-clear.
      const unexplained = [...PRESERVED_ON_RESTORE.entries()]
        .filter(([, reason]) => reason.trim().length < 40)
        .map(([table]) => table);
      expect(unexplained).toEqual([]);
    });

    it("does not clear a preserved table after all", () => {
      // The map says the restore leaves these alone; a `DELETE` added later
      // would make that false while every other test stayed green.
      const contradicted = [...PRESERVED_ON_RESTORE.keys()].filter((table) =>
        cleared.has(table),
      );
      expect(contradicted).toEqual([]);
    });
  });

  describe("conflict arbiters", () => {
    // PostgreSQL refuses a bare `ON CONFLICT DO NOTHING` on a table with a
    // DEFERRABLE unique constraint, so such a table needs a named arbiter or
    // every backup carrying one of its rows fails to restore.
    const deferrableTables = (): Set<string> => {
      const tables = new Set<string>();
      for (const [, table, body] of readSchema().matchAll(
        /CREATE TABLE(?: IF NOT EXISTS)?\s+(\w+)\s*\(([\s\S]*?)\n\);/g,
      )) {
        if (/\bDEFERRABLE\b/i.test(body)) tables.add(table);
      }
      return tables;
    };

    it("finds the deferrable constraint the parser is checked against", () => {
      expect(deferrableTables().has("transaction_rules")).toBe(true);
    });

    it("names an arbiter for every restored table with a deferrable constraint", () => {
      const missing = [...deferrableTables()].filter(
        (table) =>
          RESTORABLE_TABLES.has(table) && !CONFLICT_ARBITER_COLUMNS[table],
      );
      expect(missing).toEqual([]);
    });

    it("declares arbiters only for restored tables", () => {
      const stray = Object.keys(CONFLICT_ARBITER_COLUMNS).filter(
        (table) => !RESTORABLE_TABLES.has(table),
      );
      expect(stray).toEqual([]);
    });
  });
});
