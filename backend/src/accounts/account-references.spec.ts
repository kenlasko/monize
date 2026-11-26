import { EntityManager } from "typeorm";
import { foreignKeysTo } from "../common/schema-references.test-helpers";
import {
  ACCOUNT_REFERENCES,
  findAccountReferences,
} from "./account-references";

describe("ACCOUNT_REFERENCES", () => {
  const schemaReferences = foreignKeysTo("accounts");
  const mapped = Object.keys(ACCOUNT_REFERENCES).sort();

  it("finds the references the schema is known to declare", () => {
    expect(schemaReferences).toEqual(
      expect.arrayContaining([
        "transactions.account_id",
        "holdings.account_id",
        "accounts.linked_account_id",
      ]),
    );
  });

  it("gives every foreign key to accounts(id) a policy", () => {
    expect(schemaReferences.filter((ref) => !mapped.includes(ref))).toEqual([]);
  });

  it("names no column the schema does not reference accounts from", () => {
    expect(mapped.filter((ref) => !schemaReferences.includes(ref))).toEqual([]);
  });
});

describe("findAccountReferences", () => {
  function makeManager(
    counts: Record<string, number> = {},
    linkedIds: string[] = [],
    schedules = 0,
  ) {
    return {
      query: jest.fn((sql: string, _params?: unknown[]) => {
        if (sql.includes("COUNT(DISTINCT refs.schedule_id)")) {
          return Promise.resolve(
            schedules ? [{ accountId: "a", cnt: String(schedules) }] : [],
          );
        }
        if (sql.startsWith("SELECT id FROM accounts")) {
          return Promise.resolve(linkedIds.map((id) => ({ id })));
        }
        const hit = Object.entries(counts).find(([needle]) =>
          sql.includes(needle),
        );
        return Promise.resolve([{ count: hit ? hit[1] : 0 }]);
      }),
    };
  }
  const run = (m: unknown, options?: { includeOwnSchedule?: boolean }) =>
    findAccountReferences(m as EntityManager, "u", "a", options);

  it("returns nothing for an unused account", async () => {
    expect(await run(makeManager())).toEqual([]);
  });

  it("sums per kind, lists linked account ids and counts schedules", async () => {
    const m = makeManager(
      {
        "FROM transactions WHERE": 2,
        "FROM transaction_splits": 3,
        "FROM investment_transactions WHERE user_id = $1 AND account_id": 4,
        "FROM holdings": 5,
        "FROM budget_categories": 1,
        "FROM bank_sync_accounts": 1,
        "FROM shared_integrations": 1,
        "FROM gem_strategy_accounts": 1,
        "FROM transaction_rules": 2,
        "FROM custom_reports": 3,
        "FROM budgets": 4,
      },
      ["l1", "l2"],
      7,
    );
    const found = await run(m);
    expect(found).toEqual(
      expect.arrayContaining([
        { kind: "transactions", count: 5 },
        { kind: "investmentTransactions", count: 4 },
        { kind: "holdings", count: 5 },
        { kind: "scheduledTransactions", count: 7 },
        { kind: "budgetLines", count: 1 },
        { kind: "bankSyncLinks", count: 1 },
        { kind: "sharedIntegrations", count: 1 },
        { kind: "gemStrategies", count: 1 },
        { kind: "rules", count: 2 },
        { kind: "customReports", count: 3 },
        { kind: "budgets", count: 4 },
        { kind: "linkedAccounts", count: 2, ids: ["l1", "l2"] },
      ]),
    );
    expect(found).toHaveLength(12);
  });

  it("counts only a nonzero position as a holding", async () => {
    const m = makeManager();
    await run(m);
    expect(m.query).toHaveBeenCalledWith(
      expect.stringContaining("ABS(h.quantity) > 0.00000001"),
      ["u", "a"],
    );
  });

  it("leaves the loan's own schedule out unless asked", async () => {
    const m = makeManager();
    await run(m);
    await run(m, { includeOwnSchedule: true });
    const flags = m.query.mock.calls
      .filter(([sql]) => sql.includes("COUNT(DISTINCT refs.schedule_id)"))
      .map(([, params]) => (params as unknown[])[2]);
    expect(flags).toEqual([false, true]);
  });

  it("matches the id inside JSON as a LIKE pattern", async () => {
    const m = makeManager();
    await run(m);
    expect(m.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM budgets"),
      ["u", "%a%"],
    );
  });
});
