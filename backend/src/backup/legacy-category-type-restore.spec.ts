import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EntityManager } from "typeorm";
import { parseSchemaColumns } from "../common/db/raw-sql-columns";
import { BackupRestoreDatabaseService } from "./backup-restore-database.service";

// The shipped column list: the restore inserts only the columns schema.sql has.
const columns = parseSchemaColumns(
  readFileSync(join(__dirname, "../../../database/schema.sql"), "utf8"),
).get("categories")!;

/**
 * #2478: a `categories` row from a backup taken before 1.22.0 states its type
 * only through `is_income`, which the schema no longer has. It is inserted
 * with the type the flag named and without the flag; a row that carries a type
 * keeps it.
 */
describe("restoring categories from before the type column", () => {
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
        "categories",
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

  it("has the type and not the dropped flag in the schema", () => {
    expect(columns.has("category_type")).toBe(true);
    expect(columns.has("is_income")).toBe(false);
  });

  it.each([
    [true, "income"],
    [false, "expense"],
  ])("inserts a row flagged %s as an %s category", async (flag, type) => {
    const row = {
      id: "c-1",
      user_id: "old-user",
      name: "Salary",
      is_income: flag,
    };
    expect(await restoreOne(row)).toEqual({
      id: "c-1",
      user_id: "recipient",
      name: "Salary",
      category_type: type,
    });
  });

  it("keeps a stored type", async () => {
    expect(
      await restoreOne({
        id: "c-2",
        user_id: "old-user",
        name: "Savings",
        is_income: false,
        category_type: "transfer",
      }),
    ).toEqual({
      id: "c-2",
      user_id: "recipient",
      name: "Savings",
      category_type: "transfer",
    });
  });
});
