import { EntityManager } from "typeorm";
import { foreignKeysTo } from "../common/schema-references.test-helpers";
import {
  SECURITY_REFERENCES,
  findSecurityReferences,
} from "./security-references";

describe("SECURITY_REFERENCES", () => {
  const schemaReferences = foreignKeysTo("securities");
  const mapped = Object.keys(SECURITY_REFERENCES).sort();

  it("finds the references the schema is known to declare", () => {
    expect(schemaReferences).toEqual(
      expect.arrayContaining([
        "holdings.security_id",
        "investment_transactions.security_id",
        "security_prices.security_id",
      ]),
    );
  });

  it("gives every foreign key to securities(id) a policy", () => {
    expect(schemaReferences.filter((ref) => !mapped.includes(ref))).toEqual([]);
  });

  it("names no column the schema does not reference securities from", () => {
    expect(mapped.filter((ref) => !schemaReferences.includes(ref))).toEqual([]);
  });
});

describe("findSecurityReferences", () => {
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

  it("returns nothing for an unused security", async () => {
    const m = makeManager();
    expect(
      await findSecurityReferences(m as unknown as EntityManager, "u", "s"),
    ).toEqual([]);
  });

  it("counts every refuse column once, scoped to the user", async () => {
    const m = makeManager();
    await findSecurityReferences(m as unknown as EntityManager, "u", "s");
    expect(m.query).toHaveBeenCalledTimes(
      Object.values(SECURITY_REFERENCES).filter((r) => r.policy === "refuse")
        .length,
    );
    for (const [, params] of m.query.mock.calls) {
      expect(params).toEqual(["u", "s"]);
    }
  });

  it("counts only a nonzero holding", async () => {
    const m = makeManager();
    await findSecurityReferences(m as unknown as EntityManager, "u", "s");
    const sql = m.query.mock.calls
      .map(([s]) => s as string)
      .find((s) => s.includes("FROM holdings"));
    expect(sql).toContain("ABS(h.quantity) > 0.00000001");
  });

  it("merges schedule and scheduled-split rows into one kind", async () => {
    const m = makeManager({
      "FROM scheduled_transactions WHERE": 1,
      "FROM scheduled_transaction_splits": 2,
      "FROM holdings": 4,
      "FROM investment_transactions": 5,
      "FROM gem_strategy_assets": 1,
      "FROM gem_strategy_signals": 1,
      "FROM security_documents": 3,
    });
    expect(
      await findSecurityReferences(m as unknown as EntityManager, "u", "s"),
    ).toEqual([
      { kind: "holdings", count: 4 },
      { kind: "investmentTransactions", count: 5 },
      { kind: "scheduledTransactions", count: 3 },
      { kind: "gemStrategies", count: 2 },
      { kind: "securityDocuments", count: 3 },
    ]);
  });
});
