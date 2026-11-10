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
        rawAmount: "12.34 pending",
        date: "2026-01-16",
        payee: "Cafe",
      },
      { rowNumber: 4, rawAmount: "N/A", date: "2026-01-17", payee: "Store" },
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
      { rowNumber: 2, rawAmount: "ten dollars", date: "2026-01-15", payee: "" },
    ]);
  });

  it("returns an empty list for an empty file", () => {
    expect(parseCsv("", config()).unreadableAmountRows).toEqual([]);
  });
});
