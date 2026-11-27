import {
  withResolvedCategoryTypeColumn,
  withResolvedCategoryTypeProperty,
} from "./legacy-income-flag.util";

/**
 * #2478: `categories.is_income` is gone, but a backup or an undo snapshot taken
 * before 1.22.0 states a category's type only through it.
 */
describe("legacy income flag on a category snapshot", () => {
  it.each([
    [true, "income"],
    [false, "expense"],
  ])("gives a backup row with only the flag %s the type %s", (flag, type) => {
    const row = { id: "c1", name: "X", is_income: flag };
    expect(withResolvedCategoryTypeColumn(row)).toEqual({
      id: "c1",
      name: "X",
      category_type: type,
    });
    // The input is not mutated.
    expect(row).toEqual({ id: "c1", name: "X", is_income: flag });
  });

  it("keeps a stored type over the flag, and drops the flag", () => {
    expect(
      withResolvedCategoryTypeColumn({
        id: "c1",
        is_income: false,
        category_type: "transfer",
      }),
    ).toEqual({ id: "c1", category_type: "transfer" });
  });

  it("leaves a row with neither without a type, never a null one", () => {
    expect(withResolvedCategoryTypeColumn({ id: "c1" })).toEqual({ id: "c1" });
    expect(
      withResolvedCategoryTypeColumn({ id: "c1", is_income: null }),
    ).toEqual({ id: "c1" });
    // `category_type` is NOT NULL: a null passed through would refuse the row.
    expect(
      withResolvedCategoryTypeColumn({ id: "c1", category_type: null }),
    ).toEqual({ id: "c1" });
    expect(withResolvedCategoryTypeProperty({ categoryType: null })).toEqual(
      {},
    );
  });

  it("does the same for an undo snapshot's camelCase properties", () => {
    expect(
      withResolvedCategoryTypeProperty({ name: "Salary", isIncome: true }),
    ).toEqual({ name: "Salary", categoryType: "income" });
    expect(
      withResolvedCategoryTypeProperty({
        name: "Food",
        isIncome: true,
        categoryType: "expense",
      }),
    ).toEqual({ name: "Food", categoryType: "expense" });
    expect(withResolvedCategoryTypeProperty({ name: "Food" })).toEqual({
      name: "Food",
    });
  });
});
