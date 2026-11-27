import { EntityManager } from "typeorm";
import { categoryIdForCategoryRow } from "./category-row-gate";

describe("categoryIdForCategoryRow", () => {
  const managerWith = (rows: Record<string, unknown>) => {
    const findOne = jest.fn(
      async (_entity: unknown, opts: { where: { id: string } }) =>
        rows[opts.where.id] ?? null,
    );
    return { manager: { findOne } as unknown as EntityManager, findOne };
  };

  it("passes an Income or Expense category through and skips a Transfer one", async () => {
    const { manager } = managerWith({
      e: { id: "e", categoryType: "expense" },
      i: { id: "i", categoryType: "income" },
      t: { id: "t", categoryType: "transfer" },
    });

    expect(await categoryIdForCategoryRow(manager, "u", "e")).toBe("e");
    expect(await categoryIdForCategoryRow(manager, "u", "i")).toBe("i");
    expect(await categoryIdForCategoryRow(manager, "u", "t")).toBeNull();
    expect(await categoryIdForCategoryRow(manager, "u", null)).toBeNull();
    expect(await categoryIdForCategoryRow(manager, "u", undefined)).toBeNull();
  });

  it("asks the database once for each distinct category per manager", async () => {
    const { manager, findOne } = managerWith({
      t: { id: "t", categoryType: "transfer" },
    });

    await categoryIdForCategoryRow(manager, "u", "t");
    await categoryIdForCategoryRow(manager, "u", "t");
    await categoryIdForCategoryRow(manager, "u", "t");

    expect(findOne).toHaveBeenCalledTimes(1);
  });
});
