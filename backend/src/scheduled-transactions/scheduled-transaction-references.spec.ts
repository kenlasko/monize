import { foreignKeysTo } from "../common/schema-references.test-helpers";
import { SCHEDULED_TRANSACTION_REFERENCES } from "./scheduled-transaction-references";

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
