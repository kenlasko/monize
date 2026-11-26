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
  const makeManager = (loanIds: string[]) => ({
    query: jest.fn((_sql: string, _params?: unknown[]) =>
      Promise.resolve(loanIds.map((id) => ({ id }))),
    ),
  });
  const run = (m: unknown, options?: { includeLoanLink?: boolean }) =>
    findScheduledTransactionReferences(m as EntityManager, "u", "s", options);

  it("returns nothing for a schedule nothing else uses", async () => {
    const m = makeManager([]);
    expect(await run(m)).toEqual([]);
    expect(m.query).toHaveBeenCalledWith(expect.any(String), ["u", "s"]);
  });

  it("does not count payroll rules: they belong to the bill", async () => {
    const m = makeManager([]);
    await run(m);
    expect(m.query).toHaveBeenCalledTimes(1);
    expect(m.query.mock.calls[0][0]).not.toContain("payroll_deduction_rules");
  });

  it("reports linked loans with their ids", async () => {
    expect(await run(makeManager(["a1"]))).toEqual([
      { kind: "loanAccounts", count: 1, ids: ["a1"] },
    ]);
  });

  it("skips the loan link for the undo of a loan's creation", async () => {
    const m = makeManager(["a1"]);
    expect(await run(m, { includeLoanLink: false })).toEqual([]);
    expect(m.query).not.toHaveBeenCalled();
  });
});
