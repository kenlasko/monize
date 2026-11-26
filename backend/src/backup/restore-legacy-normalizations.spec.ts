import { EntityManager } from "typeorm";
import { BackupData } from "./backup-format";
import {
  applyLegacyNormalizations,
  artifactPredates,
  LEGACY_NORMALIZATIONS,
  LEGACY_PENDING_IMPORT_NOTE,
  legacyNormalizationsFor,
} from "./restore-legacy-normalizations";

const SKIP_PRICE_MIGRATION =
  "20261012131846_securities_skip_price_updates_user_switch.sql";
const BACKFILL_MIGRATION =
  "20261125150107_transactions_amount_is_provisional_backfill_repeat.sql";
const STRIP_MIGRATION =
  "20261126115405_transactions_strip_pending_import_note.sql";
const entry = LEGACY_NORMALIZATIONS.find(
  (e) => e.migration === SKIP_PRICE_MIGRATION,
)!;

/** An artifact with only the members the decision reads. */
const artifact = (members: Record<string, unknown>): BackupData =>
  ({ version: 1, exportedAt: "2026-10-22T00:00:00.000Z", ...members }) as never;

const preferences = (row: Record<string, unknown>) => [
  { user_id: "u", default_currency: "USD", ...row },
];

describe("restore legacy normalizations", () => {
  it("registers the skip_price_updates meaning change", () => {
    expect(entry).toBeDefined();
  });

  describe("an artifact with a producedBy marker", () => {
    it.each([
      ["an older migration", "20261012131845_before.sql", true],
      [
        "a historical sequential migration",
        "191_payee_lookup_ai_enabled.sql",
        true,
      ],
      ["the migration itself", SKIP_PRICE_MIGRATION, false],
      [
        "a later migration",
        "20261012133629_user_preferences_hidden_table_columns.sql",
        false,
      ],
    ])("%s: predates = %s", (_label, schemaMigration, predates) => {
      // Preferences without the evidence column must not matter when a marker
      // is present: the marker is the better evidence.
      const data = artifact({
        producedBy: { schemaMigration },
        user_preferences: preferences({}),
      });
      expect(artifactPredates(entry, data)).toBe(predates);
    });

    it("orders by the numeric prefix, not as a string", () => {
      // "191_" sorts before "2026..." as a string and numerically; "99999_" style
      // names are refused. A marker below the ceiling of the legacy scheme is old.
      expect(
        artifactPredates(
          entry,
          artifact({ producedBy: { schemaMigration: "068_x.sql" } }),
        ),
      ).toBe(true);
    });

    it.each([
      ["null", { schemaMigration: null }],
      ["a number", { schemaMigration: 20261012131846 }],
      ["an unparseable name", { schemaMigration: "not-a-migration.sql" }],
      ["a name with a path", { schemaMigration: "../20261012131845_x.sql" }],
      ["a string, not an object", "20261012131845_x.sql"],
    ])(
      "treats %s as no marker and falls back to the evidence",
      (_l, producedBy) => {
        const withoutKey = artifact({
          producedBy,
          user_preferences: preferences({}),
        });
        const withKey = artifact({
          producedBy,
          user_preferences: preferences({ hidden_table_columns: null }),
        });
        expect(artifactPredates(entry, withoutKey)).toBe(true);
        expect(artifactPredates(entry, withKey)).toBe(false);
      },
    );
  });

  describe("an artifact without a marker", () => {
    it("is older when its preference rows carry no hidden_table_columns key", () => {
      expect(
        artifactPredates(
          entry,
          artifact({ user_preferences: preferences({}) }),
        ),
      ).toBe(true);
    });

    it("is not older when the key is present, even as null", () => {
      for (const value of [null, [], ["payee"]]) {
        expect(
          artifactPredates(
            entry,
            artifact({
              user_preferences: preferences({ hidden_table_columns: value }),
            }),
          ),
        ).toBe(false);
      }
    });

    it("is not older without positive evidence: no preference rows", () => {
      expect(artifactPredates(entry, artifact({}))).toBe(false);
      expect(artifactPredates(entry, artifact({ user_preferences: [] }))).toBe(
        false,
      );
      expect(
        artifactPredates(entry, artifact({ user_preferences: "nope" })),
      ).toBe(false);
    });

    it("needs every preference row to lack the key", () => {
      const data = artifact({
        user_preferences: [{ user_id: "u" }, { hidden_table_columns: null }],
      });
      expect(artifactPredates(entry, data)).toBe(false);
    });
  });

  describe("applying", () => {
    const managerDouble = () => {
      const query = jest.fn().mockResolvedValue([]);
      return { manager: { query } as unknown as EntityManager, query };
    };

    it("runs the backfill scoped to the user, mirroring the migration's predicate", async () => {
      const { manager, query } = managerDouble();
      await applyLegacyNormalizations(
        manager,
        "user-1",
        artifact({ user_preferences: preferences({}) }),
      );
      expect(query).toHaveBeenCalledTimes(1);
      const [sql, params] = query.mock.calls[0];
      expect(params).toEqual(["user-1"]);
      expect(String(sql).replace(/\s+/g, " ")).toBe(
        "UPDATE securities SET skip_price_updates = false WHERE user_id = $1 " +
          "AND skip_price_updates = true " +
          "AND (quote_provider IS NOT NULL OR msn_instrument_id IS NOT NULL)",
      );
    });

    it("runs nothing for an artifact that is not older", async () => {
      const { manager, query } = managerDouble();
      await applyLegacyNormalizations(
        manager,
        "user-1",
        artifact({ producedBy: { schemaMigration: STRIP_MIGRATION } }),
      );
      expect(query).not.toHaveBeenCalled();
    });

    it("selects entries from a supplied registry in order", () => {
      const other = { ...entry, migration: "20270101000000_later.sql" };
      const data = artifact({
        producedBy: { schemaMigration: SKIP_PRICE_MIGRATION },
      });
      expect(legacyNormalizationsFor(data, [entry, other])).toEqual([other]);
    });
  });

  describe("the retired PENDING IMPORT note (issue #2400)", () => {
    const migrationsRun = (data: BackupData) =>
      legacyNormalizationsFor(data)
        .map((e) => e.migration)
        .filter((m) => m !== SKIP_PRICE_MIGRATION);

    const managerDouble = () => {
      const query = jest.fn().mockResolvedValue([]);
      return { manager: { query } as unknown as EntityManager, query };
    };

    const sqlOf = (call: unknown[]) => String(call[0]).replace(/\s+/g, " ");

    it("registers the backfill ahead of the strip, which reads no text the backfill needs", () => {
      const order = LEGACY_NORMALIZATIONS.map((e) => e.migration);
      expect(order.indexOf(BACKFILL_MIGRATION)).toBeGreaterThan(-1);
      expect(order.indexOf(STRIP_MIGRATION)).toBeGreaterThan(
        order.indexOf(BACKFILL_MIGRATION),
      );
    });

    it("holds the note exactly as the importer wrote it, emoji included", () => {
      expect([...LEGACY_PENDING_IMPORT_NOTE.slice(0, 2)]).toEqual([
        "\u26a0",
        "\ufe0f",
      ]);
      expect(LEGACY_PENDING_IMPORT_NOTE.slice(2)).toBe(
        " PENDING IMPORT: Amount may need adjustment when importing the other account.",
      );
    });

    it.each([
      [
        "before the column",
        "20261125132235_x.sql",
        [BACKFILL_MIGRATION, STRIP_MIGRATION],
      ],
      [
        "with the column, before the importer wrote it",
        "20261125132236_transactions_amount_is_provisional.sql",
        [BACKFILL_MIGRATION, STRIP_MIGRATION],
      ],
      // A reader could confirm a leg from here on, which clears the flag and
      // keeps the note: flagging by the text would undo the confirmation.
      ["after the importer wrote it", BACKFILL_MIGRATION, [STRIP_MIGRATION]],
      ["after the strip", STRIP_MIGRATION, []],
    ])(
      "an artifact produced %s runs %j",
      (_label, schemaMigration, expected) => {
        expect(
          migrationsRun(artifact({ producedBy: { schemaMigration } })),
        ).toEqual(expected);
      },
    );

    it("treats a marker-less artifact as older only when its transactions lack the column", () => {
      const without = artifact({
        transactions: [{ id: "t1", description: "x" }],
      });
      const withKey = artifact({
        transactions: [{ id: "t1", amount_is_provisional: false }],
      });
      const mixed = artifact({
        transactions: [{ id: "t1" }, { id: "t2", amount_is_provisional: true }],
      });
      expect(migrationsRun(without)).toEqual([
        BACKFILL_MIGRATION,
        STRIP_MIGRATION,
      ]);
      expect(migrationsRun(withKey)).toEqual([]);
      expect(migrationsRun(mixed)).toEqual([]);
      // No transaction rows: no evidence either way.
      expect(migrationsRun(artifact({}))).toEqual([]);
      expect(migrationsRun(artifact({ transactions: [] }))).toEqual([]);
      expect(migrationsRun(artifact({ transactions: "nope" }))).toEqual([]);
    });

    it("flags, then strips, the restoring user's imported transfer legs", async () => {
      const { manager, query } = managerDouble();
      await applyLegacyNormalizations(
        manager,
        "user-1",
        artifact({ producedBy: { schemaMigration: "20261125132235_x.sql" } }),
      );
      // Newer than the skip_price_updates migration, so only these two run.
      const calls = query.mock.calls;
      expect(calls).toHaveLength(2);
      const [backfill, strip] = calls;

      expect(backfill[1]).toEqual(["user-1"]);
      expect(sqlOf(backfill)).toContain(
        "SET amount_is_provisional = true WHERE user_id = $1 " +
          "AND amount_is_provisional = false " +
          "AND description LIKE '%PENDING IMPORT%' AND is_transfer = true " +
          "AND shared_expense_posting_id IS NULL",
      );

      expect(strip[1]).toEqual(["user-1", LEGACY_PENDING_IMPORT_NOTE]);
      expect(sqlOf(strip)).toContain(
        "SET description = NULLIF(btrim(replace(description, $2, '')), '') " +
          "WHERE user_id = $1 AND strpos(description, $2) > 0 " +
          "AND is_transfer = true AND shared_expense_posting_id IS NULL",
      );
      // The strip leaves every flag as it stands, a confirmed leg's included.
      expect(sqlOf(strip)).not.toContain("amount_is_provisional");
      for (const call of calls) {
        expect(sqlOf(call)).toContain("a.shared_expense_group_id IS NOT NULL");
      }
    });
  });

  it("keeps the registered migration names real", () => {
    // A rename of the migration file must not silently disarm the entry.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs") as typeof import("fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require("path") as typeof import("path");
    const dir = path.resolve(__dirname, "../../../database/migrations");
    for (const { migration } of LEGACY_NORMALIZATIONS) {
      expect(fs.existsSync(path.join(dir, migration))).toBe(true);
    }
  });
});
