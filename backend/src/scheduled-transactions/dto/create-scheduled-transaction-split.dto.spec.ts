import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { CreateScheduledTransactionSplitDto } from "./create-scheduled-transaction-split.dto";

/**
 * A transfer line carries its account and, optionally, a category
 * (INV-CATEGORY-002): both ids are checked, neither skips the other's.
 */
describe("CreateScheduledTransactionSplitDto", () => {
  const UUID_A = "00000000-0000-4000-8000-000000000001";
  const UUID_B = "00000000-0000-4000-8000-000000000002";
  const errorsOf = (plain: Record<string, unknown>) =>
    validateSync(
      plainToInstance(CreateScheduledTransactionSplitDto, {
        amount: -10,
        ...plain,
      }),
    ).map((error) => error.property);

  it("accepts a transfer line with a category, and each line kind alone", () => {
    expect(errorsOf({ transferAccountId: UUID_A, categoryId: UUID_B })).toEqual(
      [],
    );
    expect(errorsOf({ categoryId: UUID_B })).toEqual([]);
    expect(errorsOf({ transferAccountId: UUID_A })).toEqual([]);
    expect(errorsOf({ categoryId: null, transferAccountId: "" })).toEqual([]);
  });

  it("refuses a malformed id on a transfer line that carries both", () => {
    expect(
      errorsOf({ transferAccountId: "not-a-uuid", categoryId: "also-not" }),
    ).toEqual(["categoryId", "transferAccountId"]);
    expect(errorsOf({ transferAccountId: UUID_A, categoryId: "bad" })).toEqual([
      "categoryId",
    ]);
  });
});
