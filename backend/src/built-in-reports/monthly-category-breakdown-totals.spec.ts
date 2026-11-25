import { FxAggregate } from "../common/fx-aggregate";
import {
  breakdownTotals,
  OTHER_EXPENSE_SECTION,
  OTHER_INCOME_SECTION,
  sectionKeyOf,
  SectionedRow,
} from "./monthly-category-breakdown-totals";

const agg = (value: number): FxAggregate => {
  const sum = new FxAggregate();
  sum.addConverted(value);
  return sum;
};

/** Deposits less withdrawals per column. */
const net = (cells: Record<string, number>) =>
  new Map(Object.entries(cells).map(([column, value]) => [column, agg(value)]));

const row = (overrides: Partial<SectionedRow>): SectionedRow => ({
  categoryId: "cat",
  parentId: null,
  parentName: null,
  parentIsIncome: null,
  isIncome: false,
  ...overrides,
});

const months = ["2026-01", "2026-02", "2026-03"];

describe("breakdownTotals", () => {
  // Three months of 0.005 spending read 0.01 each, so the page's row total of
  // its cells was 0.03 where the months come to 0.015, read 0.02 (issue #2413).
  it("reads a row's total and average once from its cells' exact sum", () => {
    const result = breakdownTotals(
      [
        {
          row: row({}),
          netByColumn: net({
            "2026-01": -0.005,
            "2026-02": -0.005,
            "2026-03": -0.005,
          }),
        },
      ],
      [],
      months,
      2,
    );

    expect(result.rows[0]).toEqual({ total: 0.02, average: 0.01 });
    expect(result.sections[0]).toMatchObject({
      key: "cat",
      isIncome: false,
      valuesByMonth: { "2026-01": 0.01, "2026-02": 0.01, "2026-03": 0.01 },
      total: 0.02,
      average: 0.01,
    });
    expect(result.summary.expenses.total).toBe(0.02);
    expect(result.summary.balance.total).toBe(-0.02);
  });

  // Two subcategories of 0.005 each read 0.01 on their own: their section's
  // month, and so the expense group's, was 0.02 where they come to 0.01.
  it("folds a section and the groups from the rows' aggregates", () => {
    const result = breakdownTotals(
      [
        {
          row: row({ categoryId: "a", parentId: "food", parentName: "Food" }),
          netByColumn: net({ "2026-01": -0.005 }),
        },
        {
          row: row({ categoryId: "b", parentId: "food", parentName: "Food" }),
          netByColumn: net({ "2026-01": -0.005 }),
        },
        {
          row: row({ categoryId: "salary", isIncome: true }),
          netByColumn: net({ "2026-01": 0.015 }),
        },
      ],
      [],
      ["2026-01"],
      2,
    );

    const food = result.sections.find((section) => section.key === "food")!;
    expect(food.valuesByMonth["2026-01"]).toBe(0.01);
    expect(result.summary.expenses.valuesByMonth["2026-01"]).toBe(0.01);
    expect(result.summary.income.valuesByMonth["2026-01"]).toBe(0.02);
    // 0.015 less 0.010, read once; the readings' difference is 0.01.
    expect(result.summary.balance.valuesByMonth["2026-01"]).toBe(0.01);
  });

  it("subtracts a refund-heavy subcategory from its expense section", () => {
    const result = breakdownTotals(
      [
        {
          row: row({ categoryId: "a", parentId: "car", parentName: "Car" }),
          netByColumn: net({ "2026-01": -100 }),
        },
        {
          // A refund that outweighs its spending: an income row of its own,
          // still under the expense parent.
          row: row({
            categoryId: "b",
            parentId: "car",
            parentName: "Car",
            parentIsIncome: false,
            isIncome: true,
          }),
          netByColumn: net({ "2026-01": 30 }),
        },
      ],
      [],
      ["2026-01"],
      2,
    );

    expect(result.rows[1].total).toBe(30);
    expect(result.sections[0]).toMatchObject({
      key: "car",
      isIncome: false,
      total: 70,
    });
  });

  it("folds the transfers into the overall line and averages over every column", () => {
    const result = breakdownTotals(
      [
        {
          row: row({ categoryId: "salary", isIncome: true }),
          netByColumn: net({ "2026-01": 1000 }),
        },
      ],
      [net({ "2026-01": 0.005, "2026-03": 0.005 }), net({ "2026-02": -400 })],
      months,
      2,
    );

    expect(result.transfers[0]).toEqual({ total: 0.01, average: 0 });
    expect(result.transfers[1]).toEqual({ total: -400, average: -133.33 });
    expect(result.summary.transfers.total).toBe(-399.99);
    expect(result.summary.overall.valuesByMonth).toEqual({
      "2026-01": 1000.01,
      "2026-02": -400,
      "2026-03": 0.01,
    });
    expect(result.summary.overall.total).toBe(600.01);
    expect(result.summary.overall.average).toBe(200);
  });

  it("answers zeros for an empty window", () => {
    const result = breakdownTotals([], [], [], 2);
    expect(result.sections).toEqual([]);
    expect(result.summary.balance).toEqual({
      valuesByMonth: {},
      total: 0,
      average: 0,
    });
  });
});

describe("sectionKeyOf", () => {
  it("files a row under its parent, its own id, or the Other bucket by type", () => {
    expect(sectionKeyOf(row({ parentId: "p", parentName: "Parent" }))).toBe(
      "p",
    );
    expect(sectionKeyOf(row({ categoryId: "c" }))).toBe("c");
    expect(sectionKeyOf(row({ categoryId: null, isIncome: true }))).toBe(
      OTHER_INCOME_SECTION,
    );
    expect(sectionKeyOf(row({ categoryId: null }))).toBe(OTHER_EXPENSE_SECTION);
  });
});
