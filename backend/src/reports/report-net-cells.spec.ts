import { Transaction } from "../transactions/entities/transaction.entity";
import { DirectionFilter } from "./entities/custom-report.entity";
import { createNetCells, netLinesOf } from "./report-net-cells";

const tx = (overrides: Record<string, unknown>): Transaction =>
  ({
    id: "tx-1",
    amount: -100,
    currencyCode: "CAD",
    categoryId: "cat-1",
    isSplit: false,
    isTransfer: false,
    splits: undefined,
    ...overrides,
  }) as unknown as Transaction;

describe("netLinesOf", () => {
  it("is the row itself for a plain row", () => {
    expect(netLinesOf(tx({}), false)).toEqual([
      {
        cell: "cat-1",
        category: "cat-1",
        amount: -100,
        unit: "tx-1",
        currency: "CAD",
      },
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
    // Each line carries its split, so a transfer line converts at its own
    // counterpart's amount (discussion #2139); a whole row carries none.
    expect(netLinesOf(parent, false).map((l) => l.split)).toEqual(
      parent.splits,
    );
    expect(netLinesOf(tx({}), false)[0].split).toBeUndefined();
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
  const line = (cell: string, unit: string, amount = 0, currency = "CAD") => ({
    cell,
    category: cell,
    amount,
    unit,
    currency,
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

  it("leaves a currency part out whole when one of its lines has no rate (issue #2130)", () => {
    const leftOut: string[] = [];
    const cells = createNetCells(
      DirectionFilter.EXPENSES_ONLY,
      false,
      (currency, unit) => leftOut.push(`${currency}:${unit}`),
    );
    // Food in USD: a -100 debit that converted and a +30 refund struck on a
    // day with no rate. Keeping the debit alone would report -100, not -70.
    cells.add("g", line("food", "a", 0, "USD"), -125);
    cells.add("g", line("food", "b", 0, "USD"), null);
    // Food's CAD part and another category still net and count.
    cells.add("g", line("food", "c", 0, "CAD"), -20);
    cells.add("g", line("rent", "d", 0, "USD"), -1000);
    const settled = cells.settle().get("g")!;
    expect(settled.agg.knownSubtotal).toBe(1020);
    expect(settled.count).toBe(2);
    // The debit that converted is told of; the refund was counted already.
    expect(leftOut).toEqual(["USD:a"]);
  });

  it("counts a converted row left out only where no group kept it", () => {
    const leftOut: string[] = [];
    const cells = createNetCells(
      DirectionFilter.EXPENSES_ONLY,
      false,
      (currency, unit) => leftOut.push(`${currency}:${unit}`),
    );
    // Row "a" sits under two tags: tag A also holds "b", which has no rate,
    // so A's USD part leaves; tag B keeps "a". Row "c" is only under A.
    cells.add("A", line("food", "a", 0, "USD"), -10);
    cells.add("A", line("food", "b", 0, "USD"), null);
    cells.add("A", line("food", "c", 0, "USD"), -5);
    cells.add("B", line("food", "a", 0, "USD"), -10);

    const settled = cells.settle();

    expect(settled.has("A")).toBe(false);
    expect(settled.get("B")!.agg.knownSubtotal).toBe(10);
    expect(leftOut).toEqual(["USD:c"]);
  });

  it("keeps a whole part's lines for the count metric", () => {
    const cells = createNetCells(DirectionFilter.BOTH, true);
    cells.add("g", line("food", "a", 0, "USD"), -125);
    cells.add("g", line("food", "b", 0, "USD"), null);
    expect(cells.settle().get("g")!.count).toBe(2);
  });
});
