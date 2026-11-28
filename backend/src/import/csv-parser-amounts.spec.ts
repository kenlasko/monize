import { parseCsv, CsvColumnMappingConfig } from "./csv-parser";

function config(
  overrides?: Partial<CsvColumnMappingConfig>,
): CsvColumnMappingConfig {
  return {
    date: 0,
    amount: 1,
    payee: 2,
    dateFormat: "MM/DD/YYYY",
    hasHeader: true,
    delimiter: ",",
    ...overrides,
  };
}

function investmentConfig(): CsvColumnMappingConfig {
  return config({
    amount: 6,
    payee: undefined,
    investmentMode: true,
    actionColumn: 1,
    securityColumn: 2,
    quantityColumn: 3,
    priceColumn: 4,
    commissionColumn: 5,
  });
}

describe("parseCsv amounts", () => {
  it("reads a trailing minus, the Unicode minus and a currency code", () => {
    const csv =
      "Date,Amount,Payee\n" +
      "01/15/2026,12.34-,Trailing\n" +
      "01/15/2026,−12.34,Unicode\n" +
      "01/15/2026,CHF 12.34,Code\n" +
      "01/15/2026,DR 12.34,Debit\n";
    const result = parseCsv(csv, config());

    expect(result.transactions.map((t) => [t.payee, t.amount])).toEqual([
      ["Trailing", -12.34],
      ["Unicode", -12.34],
      ["Code", 12.34],
      ["Debit", -12.34],
    ]);
    expect(result.unreadableAmountRows).toEqual([]);
  });

  it("reports an amount it cannot read by its line and text, never as 0", () => {
    const csv =
      "Date,Amount,Payee\n" +
      "01/15/2026,-10.00,Shop\n" +
      "01/16/2026,12.34 pending,Cafe\n" +
      "01/17/2026,N/A,Store\n";
    const result = parseCsv(csv, config());

    expect(result.transactions.map((t) => t.payee)).toEqual(["Shop"]);
    expect(result.unreadableAmountRows).toEqual([
      {
        rowNumber: 3,
        field: "amount",
        rawAmount: "12.34 pending",
        date: "2026-01-16",
        payee: "Cafe",
      },
      {
        rowNumber: 4,
        field: "amount",
        rawAmount: "N/A",
        date: "2026-01-17",
        payee: "Store",
      },
    ]);
  });

  it("still reads a blank or dash-only amount as 0", () => {
    const csv = "Date,Amount,Payee\n01/15/2026,,Store\n01/16/2026,-,Shop\n";
    const result = parseCsv(csv, config());

    expect(result.transactions.map((t) => t.amount)).toEqual([0, 0]);
    expect(result.unreadableAmountRows).toEqual([]);
  });

  it("reports an unreadable debit or credit, and reads a blank side as 0", () => {
    const csv =
      "Date,Debit,Credit,Payee\n" +
      "01/15/2026,25.00,,Store\n" +
      "01/16/2026,,oops,Refund\n" +
      "01/17/2026,ten,,Shop\n";
    const result = parseCsv(
      csv,
      config({ amount: undefined, debit: 1, credit: 2, payee: 3 }),
    );

    expect(result.transactions.map((t) => t.amount)).toEqual([-25]);
    expect(
      result.unreadableAmountRows?.map((r) => [r.rowNumber, r.rawAmount]),
    ).toEqual([
      [3, "oops"],
      [4, "ten"],
    ]);
  });

  it("reports an unreadable date first when the row's date and amount both fail", () => {
    const csv = "Date,Amount,Payee\n13/13/2026,abc,Store\n";
    const result = parseCsv(csv, config());

    expect(result.unreadableDateRows?.map((r) => r.rowNumber)).toEqual([2]);
    expect(result.unreadableAmountRows).toEqual([]);
  });

  it("reports an unreadable amount in investment mode before it is classified", () => {
    const csv =
      "Date,Action,Symbol,Quantity,Price,Amount\n01/15/2026,Buy,AAPL,1,10,ten dollars\n";
    const result = parseCsv(
      csv,
      config({
        amount: 5,
        payee: undefined,
        investmentMode: true,
        actionColumn: 1,
        securityColumn: 2,
        quantityColumn: 3,
        priceColumn: 4,
      }),
    );

    expect(result.transactions).toHaveLength(0);
    expect(result.unreadableAmountRows).toEqual([
      {
        rowNumber: 2,
        field: "amount",
        rawAmount: "ten dollars",
        date: "2026-01-15",
        payee: "",
      },
    ]);
  });

  it.each([
    ["commission", "N/A"],
    ["commission", "1,2.3"],
    ["commission", "1.2.3"],
    ["quantity", "1.2.3"],
  ])(
    "reports an unreadable investment %s %j, never imports it",
    (field, bad) => {
      const cells = { quantity: "1", price: "10", commission: "5" };
      cells[field as keyof typeof cells] = `"${bad}"`;
      const csv =
        "Date,Action,Symbol,Quantity,Price,Commission,Amount\n" +
        `01/15/2026,Buy,AAPL,${cells.quantity},${cells.price},${cells.commission},15\n`;
      const result = parseCsv(csv, investmentConfig());

      expect(result.transactions).toHaveLength(0);
      expect(result.unreadableAmountRows).toEqual([
        {
          rowNumber: 2,
          field,
          rawAmount: bad,
          date: "2026-01-15",
          payee: "",
        },
      ]);
    },
  );

  const HEADER = "Date,Action,Symbol,Quantity,Price,Commission,Amount\n";

  it("derives a buy price from the amount when the price cell is unreadable", () => {
    const result = parseCsv(
      HEADER + "01/15/2026,Buy,AAPL,2,N/A,5,105\n",
      investmentConfig(),
    );

    expect(result.unreadableAmountRows).toEqual([]);
    expect(result.transactions.map((t) => t.price)).toEqual([50]);
  });

  it("reports an unreadable price when no amount can derive it", () => {
    const result = parseCsv(
      HEADER +
        "01/15/2026,Buy,AAPL,2,1.2.3,5,\n" +
        "01/16/2026,Sell,AAPL,2,N/A,5,\n",
      investmentConfig(),
    );

    expect(result.transactions).toHaveLength(0);
    expect(
      result.unreadableAmountRows?.map((r) => [r.rowNumber, r.field]),
    ).toEqual([
      [2, "price"],
      [3, "price"],
    ]);
  });

  it("reports an unreadable buy price the amount cannot derive", () => {
    const result = parseCsv(
      HEADER + '01/15/2026,Buy,AAPL,2,"1,2.3",5,5\n',
      investmentConfig(),
    );

    expect(result.transactions).toHaveLength(0);
    expect(result.unreadableAmountRows).toEqual([
      {
        rowNumber: 2,
        field: "price",
        rawAmount: "1,2.3",
        date: "2026-01-15",
        payee: "",
      },
    ]);
  });

  it.each([
    ["Shares In,AAPL,3,1.2.3,,", "price"],
    ["Add Shares,AAPL,3,N/A,,", "price"],
  ])("reports an unreadable cell on %s", (cells, field) => {
    const result = parseCsv(
      HEADER + `01/15/2026,${cells}\n`,
      investmentConfig(),
    );

    expect(result.transactions).toHaveLength(0);
    expect(result.unreadableAmountRows?.map((r) => r.field)).toEqual([field]);
  });

  it.each(["", "N/A"])(
    "reads a %j quantity and price on a dividend as unknown and imports it",
    (cell) => {
      const result = parseCsv(
        HEADER + `01/15/2026,Dividend,AAPL,${cell},${cell},,12.50\n`,
        investmentConfig(),
      );

      expect(result.unreadableAmountRows).toEqual([]);
      expect(
        result.transactions.map((t) => [t.amount, t.quantity, t.price]),
      ).toEqual([[12.5, 0, 0]]);
    },
  );

  it("returns an empty list for an empty file", () => {
    expect(parseCsv("", config()).unreadableAmountRows).toEqual([]);
  });
});
