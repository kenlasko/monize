import { EntityManager } from "typeorm";
import { foreignKeysTo } from "../common/schema-references.test-helpers";
import {
  CATEGORY_REFERENCES,
  findCategoryReferences,
} from "./category-references";

describe("CATEGORY_REFERENCES", () => {
  const schemaReferences = foreignKeysTo("categories");
  const mapped = Object.keys(CATEGORY_REFERENCES).sort();

  it("finds the references the schema is known to declare", () => {
    // A parser that matched nothing would pass both directions below vacuously.
    expect(schemaReferences).toEqual(
      expect.arrayContaining([
        "transactions.category_id",
        "accounts.principal_category_id",
        "payees.default_category_id",
      ]),
    );
  });

  it("gives every foreign key to categories(id) a policy", () => {
    expect(schemaReferences.filter((ref) => !mapped.includes(ref))).toEqual([]);
  });

  it("names no column the schema does not reference categories from", () => {
    expect(mapped.filter((ref) => !schemaReferences.includes(ref))).toEqual([]);
  });
});

describe("findCategoryReferences", () => {
  function makeManager(
    counts: Record<string, number> = {},
    loanIds: string[] = [],
  ) {
    return {
      query: jest.fn((sql: string, _params?: unknown[]) => {
        if (sql.startsWith("SELECT id FROM accounts")) {
          return Promise.resolve(loanIds.map((id) => ({ id })));
        }
        const hit = Object.entries(counts).find(([needle]) =>
          sql.includes(needle),
        );
        return Promise.resolve([{ count: hit ? hit[1] : 0 }]);
      }),
    };
  }

  it("returns nothing for an unused category", async () => {
    const m = makeManager();
    expect(
      await findCategoryReferences(m as unknown as EntityManager, "u", "c"),
    ).toEqual([]);
  });

  it("scopes every query to the user and the category", async () => {
    const m = makeManager();
    await findCategoryReferences(m as unknown as EntityManager, "u", "c");
    for (const [, params = []] of m.query.mock.calls) {
      expect(params[0]).toBe("u");
      expect(String(params[1])).toContain("c");
    }
  });

  it("sums transactions and splits into one kind and lists loan account ids", async () => {
    const m = makeManager(
      {
        "FROM transactions WHERE": 2,
        "FROM transaction_splits": 3,
        "FROM budget_categories": 1,
        "FROM transaction_rules": 4,
        "FROM custom_reports": 5,
        "FROM categories WHERE": 6,
      },
      ["a1", "a2"],
    );
    const found = await findCategoryReferences(
      m as unknown as EntityManager,
      "u",
      "c",
    );
    expect(found).toEqual(
      expect.arrayContaining([
        { kind: "transactions", count: 5 },
        { kind: "budgetLines", count: 1 },
        { kind: "rules", count: 4 },
        { kind: "customReports", count: 5 },
        { kind: "subcategories", count: 6 },
        { kind: "loanAccounts", count: 2, ids: ["a1", "a2"] },
      ]),
    );
    expect(found).toHaveLength(6);
  });

  it("matches the id inside rule JSON as a LIKE pattern", async () => {
    const m = makeManager();
    await findCategoryReferences(m as unknown as EntityManager, "u", "c-1");
    expect(m.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM transaction_rules"),
      ["u", "%c-1%"],
    );
  });
});
