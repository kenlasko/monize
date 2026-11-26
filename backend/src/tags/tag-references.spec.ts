import { EntityManager } from "typeorm";
import { foreignKeysTo } from "../common/schema-references.test-helpers";
import { TAG_REFERENCES, findTagReferences } from "./tag-references";

describe("TAG_REFERENCES", () => {
  const schemaReferences = foreignKeysTo("tags");
  const mapped = Object.keys(TAG_REFERENCES).sort();

  it("finds the references the schema is known to declare", () => {
    expect(schemaReferences).toEqual(
      expect.arrayContaining([
        "transaction_tags.tag_id",
        "security_tags.tag_id",
      ]),
    );
  });

  it("gives every foreign key to tags(id) a policy", () => {
    expect(schemaReferences.filter((ref) => !mapped.includes(ref))).toEqual([]);
  });

  it("names no column the schema does not reference tags from", () => {
    expect(mapped.filter((ref) => !schemaReferences.includes(ref))).toEqual([]);
  });
});

describe("findTagReferences", () => {
  function makeManager(counts: Record<string, number> = {}) {
    return {
      query: jest.fn((sql: string, _params?: unknown[]) => {
        const hit = Object.entries(counts).find(([needle]) =>
          sql.includes(needle),
        );
        return Promise.resolve([{ count: hit ? hit[1] : 0 }]);
      }),
    };
  }

  it("returns nothing for an unused tag", async () => {
    const m = makeManager();
    expect(
      await findTagReferences(m as unknown as EntityManager, "u", "t"),
    ).toEqual([]);
  });

  it("sums links and JSON ids per kind", async () => {
    const m = makeManager({
      "FROM transaction_tags": 2,
      "FROM transaction_split_tags": 1,
      "FROM scheduled_transaction_split_tags": 1,
      "FROM scheduled_transactions": 2,
      "FROM security_tags": 4,
      "FROM transaction_rules": 5,
      "FROM custom_reports": 6,
    });
    const found = await findTagReferences(
      m as unknown as EntityManager,
      "u",
      "t",
    );
    expect(found).toEqual(
      expect.arrayContaining([
        { kind: "transactions", count: 3 },
        { kind: "scheduledTransactions", count: 3 },
        { kind: "securities", count: 4 },
        { kind: "rules", count: 5 },
        { kind: "customReports", count: 6 },
      ]),
    );
    expect(found).toHaveLength(5);
  });

  it("scopes every query to the user and matches JSON ids by LIKE", async () => {
    const m = makeManager();
    await findTagReferences(m as unknown as EntityManager, "u", "t-1");
    for (const [, params = []] of m.query.mock.calls) {
      expect(params[0]).toBe("u");
      expect(String(params[1])).toContain("t-1");
    }
    expect(m.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM custom_reports"),
      ["u", "%t-1%"],
    );
  });
});
