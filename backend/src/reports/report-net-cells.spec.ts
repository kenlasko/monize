import { Transaction } from "../transactions/entities/transaction.entity";
import { DirectionFilter } from "./entities/custom-report.entity";
import { createNetCells, netLinesOf } from "./report-net-cells";

const tx = (overrides: Record<string, unknown>): Transaction =>
  ({
    id: "tx-1",
    amount: -100,
    categoryId: "cat-1",
    isSplit: false,
    isTransfer: false,
    splits: undefined,
    ...overrides,
  }) as unknown as Transaction;

describe("netLinesOf", () => {
  it("is the row itself for a plain row", () => {
    expect(netLinesOf(tx({}), false)).toEqual([
      { cell: "cat-1", category: "cat-1", amount: -100, unit: "tx-1" },
    ]);
  });

  it("files a row with no category under uncategorized", () => {
    expect(netLinesOf(tx({ categoryId: null }), true)[0]).toMatchObject({
      category: "uncategorized",
      unit: "tx-1:0",
    });
  });

  it("is the row itself for a split parent whose lines were not hydrated", () => {
    expect(netLinesOf(tx({ isSplit: true }), false)).toHaveLength(1);
  });

  it("is each ordinary line of a hydrated split parent, none when empty", () => {
    const parent = tx({
      isSplit: true,
      splits: [
        { amount: -60, categoryId: "a" },
        { amount: -40, categoryId: null },
      ],
    });
    expect(netLinesOf(parent, true).map((l) => [l.category, l.unit])).toEqual([
      ["a", "tx-1:0"],
      ["uncategorized", "tx-1:1"],
    ]);
    expect(netLinesOf(tx({ isSplit: true, splits: [] }), false)).toEqual([]);
  });

  it("gives a transfer row and a transfer line a cell of their own", () => {
    expect(netLinesOf(tx({ isTransfer: true }), false)[0].cell).toBe(
      "transfer:tx-1:0",
    );
    const parent = tx({
      isSplit: true,
      splits: [{ amount: -5, categoryId: "a", transferAccountId: "acc-2" }],
    });
    expect(netLinesOf(parent, false)[0].cell).toBe("transfer:tx-1:0");
  });
});

describe("NetCells", () => {
  const line = (cell: string, unit: string, amount = 0) => ({
    cell,
    category: cell,
    amount,
    unit,
  });

  it("nets a refund inside one category for EXPENSES_ONLY", () => {
    const cells = createNetCells(DirectionFilter.EXPENSES_ONLY, false);
    cells.add("g", line("food", "a"), -100);
    cells.add("g", line("food", "b"), 30);
    cells.add("g", line("pay", "c"), 5000);
    const settled = cells.settle().get("g")!;
    expect(settled.agg.knownSubtotal).toBe(70);
    expect(settled.count).toBe(2);
  });

  it("drops a group whose categories net to income or zero", () => {
    const cells = createNetCells(DirectionFilter.EXPENSES_ONLY, false);
    cells.add("g", line("food", "a"), -30);
    cells.add("g", line("food", "b"), 30);
    expect(cells.settle().has("g")).toBe(false);
  });

  it("keeps only positive nets for INCOME_ONLY", () => {
    const cells = createNetCells(DirectionFilter.INCOME_ONLY, false);
    cells.add("g", line("pay", "a"), 100);
    cells.add("g", line("pay", "b"), -30);
    cells.add("g", line("food", "c"), -50);
    expect(cells.settle().get("g")!.agg.knownSubtotal).toBe(70);
  });

  it("sums the magnitude of each category's net for BOTH", () => {
    const cells = createNetCells(DirectionFilter.BOTH, false);
    cells.add("g", line("food", "a"), -100);
    cells.add("g", line("food", "b"), 30);
    cells.add("g", line("pay", "c"), 5000);
    expect(cells.settle().get("g")!.agg.knownSubtotal).toBe(5070);
  });

  it("counts a unit once however many lines it adds", () => {
    const cells = createNetCells(DirectionFilter.EXPENSES_ONLY, false);
    cells.add("g", line("a", "tx"), -10);
    cells.add("g", line("b", "tx"), -10);
    expect(cells.settle().get("g")!.count).toBe(1);
  });

  it("leaves an unconverted line out unless the metric keeps it", () => {
    const money = createNetCells(DirectionFilter.EXPENSES_ONLY, false);
    money.add("g", line("a", "x"), null);
    expect(money.settle().size).toBe(0);

    const count = createNetCells(DirectionFilter.BOTH, true);
    count.add("g", line("a", "x"), null);
    expect(count.settle().get("g")!.count).toBe(1);
  });
});

describe("recognition event counts without FX", () => {
  it("keeps separate recognition events from the same payment", () => {
    const first = tx({
      id: "payment",
      amount: -100,
      categoryId: "tax",
      reportingProvenance: { reportId: "june" },
    });
    const second = tx({ ...first, reportingProvenance: { reportId: "july" } });
    const cells = createNetCells(DirectionFilter.EXPENSES_ONLY, true);
    for (const tx of [first, second])
      for (const line of netLinesOf(tx, false)) cells.add("period", line, null);
    expect(cells.settle().get("period")?.count).toBe(2);
  });
  it.each([
    [DirectionFilter.EXPENSES_ONLY, 1],
    [DirectionFilter.INCOME_ONLY, 1],
    [DirectionFilter.BOTH, 3],
  ])(
    "counts native direction %s without inventing a conversion",
    (direction, expected) => {
      const cells = createNetCells(direction, true);
      for (const [unit, amount] of [
        ["expense", -100],
        ["refund", 30],
        ["zero", 0],
      ] as const)
        cells.add(
          "period",
          { cell: "category", category: "category", unit, amount },
          null,
        );
      const result = cells.settle().get("period")!;
      expect(result.count).toBe(expected);
      expect(result.agg.knownSubtotal).toBe(0);
    },
  );
});
