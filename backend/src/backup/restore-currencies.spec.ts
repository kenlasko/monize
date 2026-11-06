import { EntityManager } from "typeorm";
import { BackupRestoreDatabaseService } from "./backup-restore-database.service";
import type { BackupData } from "./backup-format";

/**
 * `currencies` is a table every user shares, so a restored row is validated the
 * way the create DTO validates a typed one before it is inserted.
 */
describe("BackupRestoreDatabaseService.ensureCurrenciesExist (restored currency rows)", () => {
  const userId = "user-1";
  let inserts: { sql: string; params: unknown[] }[];
  let manager: EntityManager;

  beforeEach(() => {
    inserts = [];
    manager = {
      query: jest.fn(async (sql: string, params: unknown[] = []) => {
        if (/information_schema\.columns/.test(sql)) {
          return [
            "code",
            "name",
            "symbol",
            "decimal_places",
            "is_active",
            "created_by_user_id",
            "kind",
            "quote_symbol",
          ].map((column_name) => ({ column_name }));
        }
        if (/INSERT INTO "currencies"/.test(sql)) {
          inserts.push({ sql, params });
          return [];
        }
        // The existence check: nothing is missing once the rows are in.
        return (params[0] as string[] | undefined)?.map((code) => ({ code }));
      }),
    } as unknown as EntityManager;
  });

  const restore = (currencies: Record<string, unknown>[]) =>
    new BackupRestoreDatabaseService().ensureCurrenciesExist(
      manager,
      {
        accounts: [{ currency_code: "ZZZ" }],
        currencies,
      } as unknown as BackupData,
      userId,
    );

  const paramsByColumn = (insert: { sql: string; params: unknown[] }) => {
    const columns = [...insert.sql.matchAll(/"(\w+)"/g)]
      .map((m) => m[1])
      .slice(1, 1 + insert.params.length);
    return Object.fromEntries(columns.map((c, i) => [c, insert.params[i]]));
  };

  it("skips a row whose code is not three capital letters", async () => {
    await restore([
      { code: "usd", name: "Dollar", symbol: "$" },
      { code: "TOOLONG", name: "Dollar", symbol: "$" },
      { code: 12, name: "Dollar", symbol: "$" },
      { name: "No code", symbol: "$" },
    ]);

    expect(inserts).toEqual([]);
  });

  it("clamps decimal_places to an integer from 0 to 8, and defaults a non-number to 2", async () => {
    await restore([
      { code: "AAA", name: "A", symbol: "A", decimal_places: -2 },
      { code: "BBB", name: "B", symbol: "B", decimal_places: 99 },
      { code: "CCC", name: "C", symbol: "C", decimal_places: 2.7 },
      { code: "DDD", name: "D", symbol: "D", decimal_places: "x" },
      { code: "EEE", name: "E", symbol: "E", decimal_places: 8 },
      { code: "FFF", name: "F", symbol: "F", decimal_places: 9 },
      { code: "GGG", name: "G", symbol: "G", decimal_places: 6 },
    ]);

    expect(inserts.map((i) => paramsByColumn(i).decimal_places)).toEqual([
      0, 8, 2, 2, 8, 8, 6,
    ]);
  });

  it("strips angle brackets and caps name and symbol at the column lengths", async () => {
    await restore([
      {
        code: "AAA",
        name: `<b>${"n".repeat(200)}</b>`,
        symbol: `<i>${"s".repeat(40)}</i>`,
      },
    ]);

    const row = paramsByColumn(inserts[0]);
    expect(row.name).toBe("b" + "n".repeat(99));
    expect(row.symbol).toBe("i" + "s".repeat(9));
    expect(row.created_by_user_id).toBe(userId);
  });

  it("skips a row whose name or symbol is empty after sanitizing", async () => {
    await restore([
      { code: "AAA", name: "<>", symbol: "$" },
      { code: "BBB", name: "Bee", symbol: "<>" },
      { code: "CCC", name: 5, symbol: "$" },
      { code: "DDD", name: "Dee", symbol: "D" },
    ]);

    expect(inserts.map((i) => paramsByColumn(i).code)).toEqual(["DDD"]);
  });

  it("restores a row from before currencies had a kind as FIAT with no price symbol", async () => {
    await restore([{ code: "AAA", name: "A", symbol: "A", decimal_places: 2 }]);

    const row = paramsByColumn(inserts[0]);
    expect(row.kind).toBe("FIAT");
    expect(row.quote_symbol).toBeNull();
  });

  it("keeps a coin's kind and its price symbol, upper-cased", async () => {
    await restore([
      {
        code: "BTC",
        name: "Bitcoin",
        symbol: "B",
        decimal_places: 4,
        kind: "CRYPTO",
        quote_symbol: " btc-cad ",
      },
    ]);

    const row = paramsByColumn(inserts[0]);
    expect(row.kind).toBe("CRYPTO");
    expect(row.quote_symbol).toBe("BTC-CAD");
  });

  it("reads an unknown kind as FIAT and drops a price symbol the kind does not admit", async () => {
    await restore([
      // A symbol on a fiat row would fail the CHECK and the whole restore.
      {
        code: "AAA",
        name: "A",
        symbol: "A",
        kind: "FIAT",
        quote_symbol: "BTC-CAD",
      },
      {
        code: "BBB",
        name: "B",
        symbol: "B",
        kind: "STOCK",
        quote_symbol: "BTC-CAD",
      },
      // A coin's symbol with no fiat leg, and one past the column's length.
      {
        code: "CCC",
        name: "C",
        symbol: "C",
        kind: "CRYPTO",
        quote_symbol: "BTC",
      },
      {
        code: "DDD",
        name: "D",
        symbol: "D",
        kind: "CRYPTO",
        quote_symbol: `${"X".repeat(20)}-CAD`,
      },
    ]);

    expect(
      inserts.map((i) => {
        const row = paramsByColumn(i);
        return [row.code, row.kind, row.quote_symbol];
      }),
    ).toEqual([
      ["AAA", "FIAT", null],
      ["BBB", "FIAT", null],
      ["CCC", "CRYPTO", null],
      ["DDD", "CRYPTO", null],
    ]);
  });
});
