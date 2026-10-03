import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EntityManager } from "typeorm";
import { parseSchemaColumns } from "../common/db/raw-sql-columns";
import { BackupRestoreDatabaseService } from "./backup-restore-database.service";

// The shipped column list, so the fixture cannot keep the dropped flags after
// the contract migration removes them from real databases.
const columns = parseSchemaColumns(
  readFileSync(join(__dirname, "../../../database/schema.sql"), "utf8"),
).get("accounts")!;

/**
 * docs/specs/mortgage-types.md, task P3-B1: an `accounts` row from a backup
 * taken before the type was required is inserted with the type the contract
 * migration would have given it, and without the dropped flags. The real
 * database round trip is in `backup-restore.integration.spec.ts`.
 */
describe("restoring accounts from before the mortgage-type contract", () => {
  const restoreOne = async (row: Record<string, unknown>) => {
    const query = jest
      .fn()
      .mockResolvedValueOnce(
        [...columns].map((column_name) => ({
          column_name,
          data_type: "text",
          column_default: null,
        })),
      )
      .mockResolvedValue([]);
    const service = new BackupRestoreDatabaseService();
    expect(
      await service.insertRows(
        { query } as unknown as EntityManager,
        "accounts",
        [row],
        "recipient",
      ),
    ).toBe(1);
    const [sql, values] = query.mock.calls[1] as [string, unknown[]];
    const inserted = sql
      .slice(sql.indexOf("(") + 1, sql.indexOf(")"))
      .split(", ")
      .map((c) => c.replace(/"/g, ""));
    return Object.fromEntries(inserted.map((c, i) => [c, values[i]]));
  };

  it("has dropped the flags from the schema", () => {
    expect(columns.has("mortgage_type")).toBe(true);
    expect(columns.has("is_canadian_mortgage")).toBe(false);
    expect(columns.has("is_variable_rate")).toBe(false);
  });

  it.each([
    [true, false, "CANADIAN_FIXED"],
    [true, true, "ANNUITY"],
    [false, false, "ANNUITY"],
  ])(
    "inserts a pre-Phase-1 mortgage with flags (%s, %s) as %s",
    async (isCanadian, isVariable, type) => {
      const row = {
        id: "m-1",
        user_id: "old-user",
        account_type: "MORTGAGE",
        name: "Home",
        is_canadian_mortgage: isCanadian,
        is_variable_rate: isVariable,
      };
      expect(await restoreOne(row)).toEqual({
        id: "m-1",
        user_id: "recipient",
        account_type: "MORTGAGE",
        name: "Home",
        mortgage_type: type,
      });
      // The backup's own row is not rewritten.
      expect(row).not.toHaveProperty("mortgage_type");
    },
  );

  it("inserts a Phase 1 row's null type as the default on a non-mortgage", async () => {
    expect(
      await restoreOne({
        id: "c-1",
        user_id: "old-user",
        account_type: "CHEQUING",
        name: "Chequing",
        mortgage_type: null,
        is_canadian_mortgage: false,
        is_variable_rate: false,
      }),
    ).toMatchObject({ account_type: "CHEQUING", mortgage_type: "ANNUITY" });
  });

  it("keeps a stored type", async () => {
    expect(
      await restoreOne({
        id: "m-2",
        user_id: "old-user",
        account_type: "MORTGAGE",
        name: "Hypotheek",
        mortgage_type: "LINEAR",
        is_canadian_mortgage: false,
        is_variable_rate: false,
      }),
    ).toMatchObject({ mortgage_type: "LINEAR" });
  });
});
