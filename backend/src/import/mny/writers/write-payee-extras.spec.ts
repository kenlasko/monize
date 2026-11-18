import { EntityManager, QueryFailedError } from "typeorm";
import { MappedPayee } from "../model/mny-import-model";
import { writePayeeExtras } from "./write-payee-extras";

type FillRow = Partial<{
  old_default_category_id: string | null;
  old_notes: string | null;
  old_email: string | null;
  old_phone: string | null;
  old_address: string | null;
}>;

interface Fixture {
  payees?: { id: string; name: string }[];
  aliases?: { alias: string; payee_id: string }[];
  /** Per payee id: the values the row held before the update. */
  before?: Record<string, FillRow>;
  failSave?: (alias: string) => boolean;
}

function build(fixture: Fixture = {}) {
  const saved: { payeeId: string; alias: string }[] = [];
  const statements: string[] = [];
  const manager = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      statements.push(sql.trim().split(/\s+/).slice(0, 3).join(" "));
      if (sql.includes("SELECT id, name FROM payees")) {
        return fixture.payees ?? [];
      }
      if (sql.includes("FROM payee_aliases")) {
        return fixture.aliases ?? [];
      }
      if (sql.startsWith("UPDATE payees")) {
        const id = params?.[0] as string;
        const before = fixture.before?.[id] ?? {};
        return [
          [
            {
              old_default_category_id: null,
              old_notes: null,
              old_email: null,
              old_phone: null,
              old_address: null,
              ...before,
            },
          ],
          1,
        ];
      }
      return [];
    }),
    create: jest.fn((_cls: unknown, value: unknown) => value),
    save: jest.fn(async (value: { payeeId: string; alias: string }) => {
      if (fixture.failSave?.(value.alias)) {
        throw Object.assign(new QueryFailedError("q", [], new Error("dup")), {
          driverError: { code: "23505" },
        });
      }
      saved.push(value);
      return value;
    }),
  };
  return { manager: manager as unknown as EntityManager, saved, statements };
}

const idByName = new Map([
  ["City Power", "p-city"],
  ["Coffee", "p-coffee"],
  ["Prime Video", "p-prime"],
]);
const categoryIdByHandle = new Map([[7, "cat-electricity"]]);

const run = (
  manager: EntityManager,
  payees: MappedPayee[],
  ids: ReadonlyMap<string, string> = idByName,
) =>
  writePayeeExtras(manager, "user-1", {
    payees,
    payeeIdByName: ids,
    categoryIdByHandle,
  });

describe("writePayeeExtras (spec 5.5.4)", () => {
  it("issues no query for payees without a new field (every Money file)", async () => {
    const { manager, statements } = build();
    const result = await run(manager, [
      { handle: 1, name: "City Power" },
      { handle: 2, name: "Coffee" },
    ]);
    expect(result).toEqual({
      aliasesCreated: 0,
      defaultCategoriesSet: 0,
      contactDetailsSet: 0,
      warnings: [],
    });
    expect(statements).toEqual([]);
  });

  it("fills the default category and contact details of a new payee, in one statement per payee", async () => {
    const { manager, statements } = build();
    const result = await run(manager, [
      {
        handle: 1,
        name: "City Power",
        defaultCategoryHandle: 7,
        contact: {
          notes: "n",
          email: null,
          phone: "+12025550123",
          address: null,
        },
      },
    ]);
    expect(result).toMatchObject({
      defaultCategoriesSet: 1,
      contactDetailsSet: 1,
      aliasesCreated: 0,
      warnings: [],
    });
    expect(statements).toEqual(["UPDATE payees SET"]);
    const [sql, params] = (manager.query as jest.Mock).mock.calls[0];
    expect(sql).toContain("COALESCE(payees.default_category_id, $3)");
    expect(sql).toContain("NULLIF(payees.notes, '')");
    expect(params).toEqual([
      "p-city",
      "user-1",
      "cat-electricity",
      "n",
      null,
      "+12025550123",
      null,
    ]);
  });

  it("keeps an existing payee's own values and names them in payeeDetailsKept", async () => {
    const { manager } = build({
      before: {
        "p-city": {
          old_default_category_id: "cat-own",
          old_notes: "mine",
          old_email: "me@example.com",
        },
      },
    });
    const result = await run(manager, [
      {
        handle: 1,
        name: "City Power",
        defaultCategoryHandle: 7,
        contact: {
          notes: "theirs",
          email: "other@example.com",
          phone: "+12025550123",
          address: null,
        },
      },
    ]);
    expect(result.defaultCategoriesSet).toBe(0);
    expect(result.contactDetailsSet).toBe(1); // the phone landed
    expect(result.warnings).toEqual([
      {
        code: "payeeDetailsKept",
        subject: "City Power",
        detail: "default category, notes, email",
      },
    ]);
  });

  it("does not report a kept value that equals the one in the file", async () => {
    const { manager } = build({
      before: {
        "p-city": {
          old_default_category_id: "cat-electricity",
          old_notes: "n",
        },
      },
    });
    const result = await run(manager, [
      {
        handle: 1,
        name: "City Power",
        defaultCategoryHandle: 7,
        contact: { notes: "n", email: null, phone: null, address: null },
      },
    ]);
    expect(result).toMatchObject({
      defaultCategoriesSet: 0,
      contactDetailsSet: 0,
      warnings: [],
    });
  });

  it("treats an empty string as empty", async () => {
    const { manager } = build({ before: { "p-city": { old_notes: "" } } });
    const result = await run(manager, [
      {
        handle: 1,
        name: "City Power",
        contact: { notes: "n", email: null, phone: null, address: null },
      },
    ]);
    expect(result.contactDetailsSet).toBe(1);
  });

  it("creates aliases through the savepoint insert, counting them", async () => {
    const { manager, saved, statements } = build({
      payees: [
        { id: "p-city", name: "City Power" },
        { id: "p-coffee", name: "Coffee" },
      ],
    });
    const result = await run(manager, [
      { handle: 1, name: "City Power", aliases: ["*CITY POWER*"] },
      { handle: 2, name: "Coffee", aliases: ["*STARBUCKS*", "Costa"] },
    ]);
    expect(result.aliasesCreated).toBe(3);
    expect(saved).toEqual([
      { payeeId: "p-city", userId: "user-1", alias: "*CITY POWER*" },
      { payeeId: "p-coffee", userId: "user-1", alias: "*STARBUCKS*" },
      { payeeId: "p-coffee", userId: "user-1", alias: "Costa" },
    ]);
    expect(statements.filter((s) => s.startsWith("SAVEPOINT"))).toHaveLength(3);
    expect(statements.filter((s) => s.startsWith("UPDATE"))).toHaveLength(0);
  });

  it("refuses an alias an existing alias of another payee matches, and says which", async () => {
    const { manager, saved } = build({
      payees: [
        { id: "p-coffee", name: "Coffee" },
        { id: "p-prime", name: "Prime Video" },
      ],
      aliases: [{ alias: "*STARBUCKS*", payee_id: "p-coffee" }],
    });
    const result = await run(manager, [
      { handle: 3, name: "Prime Video", aliases: ["STARBUCKS RESERVE*"] },
    ]);
    expect(saved).toEqual([]);
    expect(result.aliasesCreated).toBe(0);
    expect(result.warnings).toEqual([
      {
        code: "payeeMatchKeyConflict",
        subject: "Prime Video: STARBUCKS RESERVE*",
        detail: "Coffee: *STARBUCKS*",
      },
    ]);
  });

  it("refuses an exact alias equal to another existing payee's name", async () => {
    const { manager, saved } = build({
      payees: [
        { id: "p-coffee", name: "Coffee" },
        { id: "p-prime", name: "Prime Video" },
      ],
    });
    const result = await run(manager, [
      { handle: 3, name: "Prime Video", aliases: ["COFFEE"] },
    ]);
    expect(saved).toEqual([]);
    expect(result.warnings).toEqual([
      {
        code: "payeeMatchKeyConflict",
        subject: "Prime Video: COFFEE",
        detail: "Coffee (name)",
      },
    ]);
  });

  it("imports an alias that can match the same text as another payee's and warns", async () => {
    const { manager, saved } = build({
      payees: [
        { id: "p-coffee", name: "Coffee" },
        { id: "p-prime", name: "Prime Video" },
      ],
      aliases: [{ alias: "*AMAZON*", payee_id: "p-coffee" }],
    });
    const result = await run(manager, [
      { handle: 3, name: "Prime Video", aliases: ["*PRIME*"] },
    ]);
    expect(saved).toHaveLength(1);
    expect(result.warnings).toEqual([
      {
        code: "payeeMatchKeyOverlap",
        subject: "Prime Video: *PRIME*",
        detail: "Coffee: *AMAZON*",
      },
    ]);
  });

  it("skips silently an alias the payee already has", async () => {
    const { manager, saved } = build({
      payees: [{ id: "p-city", name: "City Power" }],
      aliases: [{ alias: "*city power*", payee_id: "p-city" }],
    });
    const result = await run(manager, [
      { handle: 1, name: "City Power", aliases: ["*CITY POWER*"] },
    ]);
    expect(saved).toEqual([]);
    expect(result).toMatchObject({ aliasesCreated: 0, warnings: [] });
  });

  it("turns a unique-index violation into a skipped alias with a conflict warning", async () => {
    const { manager, saved, statements } = build({
      payees: [{ id: "p-city", name: "City Power" }],
      failSave: (alias) => alias === "RACED",
    });
    const result = await run(manager, [
      { handle: 1, name: "City Power", aliases: ["RACED", "KEPT"] },
    ]);
    expect(saved.map((s) => s.alias)).toEqual(["KEPT"]);
    expect(result.aliasesCreated).toBe(1);
    expect(result.warnings).toEqual([
      {
        code: "payeeMatchKeyConflict",
        subject: "City Power: RACED",
        detail: "alias already exists",
      },
    ]);
    expect(statements.some((s) => s.startsWith("ROLLBACK"))).toBe(true);
  });

  it("checks one imported payee's alias against the previous imported payee's", async () => {
    const { manager, saved } = build({
      payees: [
        { id: "p-coffee", name: "Coffee" },
        { id: "p-prime", name: "Prime Video" },
      ],
    });
    const result = await run(manager, [
      { handle: 1, name: "Coffee", aliases: ["*X*"] },
      { handle: 2, name: "Prime Video", aliases: ["X"] },
    ]);
    expect(saved.map((s) => s.alias)).toEqual(["*X*"]);
    expect(result.warnings[0]).toMatchObject({
      code: "payeeMatchKeyConflict",
      detail: "Coffee: *X*",
    });
  });

  it("skips a payee the writer has no id for", async () => {
    const { manager, saved } = build();
    const result = await run(
      manager,
      [{ handle: 1, name: "Ghost", aliases: ["G"], defaultCategoryHandle: 7 }],
      new Map(),
    );
    expect(saved).toEqual([]);
    expect(result.aliasesCreated).toBe(0);
  });
});
