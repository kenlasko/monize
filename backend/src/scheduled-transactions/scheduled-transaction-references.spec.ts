import { EntityManager } from "typeorm";
import { foreignKeysTo } from "../common/schema-references.test-helpers";
import {
  SCHEDULED_TRANSACTION_REFERENCES,
  findScheduledTransactionReferences,
} from "./scheduled-transaction-references";

describe("SCHEDULED_TRANSACTION_REFERENCES", () => {
  const schemaReferences = foreignKeysTo("scheduled_transactions");
  const mapped = Object.keys(SCHEDULED_TRANSACTION_REFERENCES).sort();

  it("finds the references the schema is known to declare", () => {
    expect(schemaReferences).toEqual(
      expect.arrayContaining([
        "accounts.scheduled_transaction_id",
        "payroll_deduction_rules.scheduled_transaction_id",
      ]),
    );
  });

  it("gives every foreign key to scheduled_transactions(id) a policy", () => {
    expect(schemaReferences.filter((ref) => !mapped.includes(ref))).toEqual([]);
  });

  it("names no column the schema does not reference schedules from", () => {
    expect(mapped.filter((ref) => !schemaReferences.includes(ref))).toEqual([]);
  });
});

describe("findScheduledTransactionReferences", () => {
  function makeManager(rules: number, loanIds: string[]) {
    return {
      query: jest.fn((sql: string, _params?: unknown[]) =>
        Promise.resolve(
          sql.startsWith("SELECT id")
            ? loanIds.map((id) => ({ id }))
            : [{ count: rules }],
        ),
      ),
    };
  }

  it("returns nothing for a schedule nothing else uses", async () => {
    const m = makeManager(0, []);
    expect(
      await findScheduledTransactionReferences(
        m as unknown as EntityManager,
        "u",
        "s",
      ),
    ).toEqual([]);
    expect(m.query).toHaveBeenCalledTimes(2);
    for (const [, params] of m.query.mock.calls) {
      expect(params).toEqual(["u", "s"]);
    }
  });

  it("reports payroll rules by count and linked loans with their ids", async () => {
    const m = makeManager(2, ["a1"]);
    expect(
      await findScheduledTransactionReferences(
        m as unknown as EntityManager,
        "u",
        "s",
      ),
    ).toEqual([
      { kind: "payrollDeductionRules", count: 2 },
      { kind: "loanAccounts", count: 1, ids: ["a1"] },
    ]);
  });
});
