import { readFileSync } from "fs";
import { join } from "path";
import {
  detectCurrency,
  inferDayFirst,
  inferDecimalSeparator,
  mapHeader,
  parseDate,
  parseNumber,
  parseQuoteTable,
} from "./html-table-quote.parser";

const NOW = new Date(Date.UTC(2026, 10, 2));
const fixture = (name: string) =>
  readFileSync(join(__dirname, "__fixtures__", "quote-tables", name), "utf8");
const ymd = (d: Date) => d.toISOString().slice(0, 10);

describe("parseQuoteTable", () => {
  it("reads ariva.de: German headers, dd.MM.yy dates and 3.609,23 € prices", () => {
    const table = parseQuoteTable(fixture("ariva-historische-kurse.html"), NOW);

    expect(table).not.toBeNull();
    // The page's other table ("Keine Daten vorhanden") is not the one read.
    expect(table!.tableIndex).toBe(1);
    expect(table!.columns).toEqual({
      date: "Datum",
      close: "Schluss",
      open: "Erster",
      high: "Hoch",
      low: "Tief",
      volume: "Stücke",
    });
    expect(table!.currencyCode).toBe("EUR");
    expect(table!.prices).toHaveLength(23);
    expect(table!.skippedRows).toBe(0);

    const first = table!.prices[0];
    const last = table!.prices[table!.prices.length - 1];
    expect(ymd(first.date)).toBe("2026-10-01");
    expect(ymd(last.date)).toBe("2026-11-02");
    expect(last).toMatchObject({
      open: 3623.81,
      high: 3635.17,
      low: 3604.05,
      close: 3609.23,
      adjClose: null,
      // "-" is no volume, not zero.
      volume: null,
    });
    // One decimal on the page ("3.749,9 €") is still the comma decimal.
    const oct29 = table!.prices.find((p) => ymd(p.date) === "2026-10-29");
    expect(oct29).toMatchObject({ high: 3749.9, low: 3707.1, close: 3715.3 });
  });

  it("reads markets.ft.com: a date written twice in one cell and US numbers", () => {
    const table = parseQuoteTable(fixture("ft-historical.html"), NOW);

    expect(table).not.toBeNull();
    expect(table!.columns).toMatchObject({ date: "Date", close: "Close" });
    // FT names no currency beside the numbers.
    expect(table!.currencyCode).toBeNull();
    expect(table!.prices).toHaveLength(21);
    expect(ymd(table!.prices[0].date)).toBe("2026-10-05");

    const last = table!.prices[table!.prices.length - 1];
    expect(ymd(last.date)).toBe("2026-11-02");
    expect(last).toMatchObject({
      open: 95.51,
      high: 95.69,
      low: 95.51,
      close: 95.69,
    });
    // "6,996" (long form), not "7.00k" (short form) and not 6.996.
    const oct30 = table!.prices.find((p) => ymd(p.date) === "2026-10-30");
    expect(oct30).toMatchObject({ close: 95.55, volume: 6996 });
  });

  it("returns oldest first with one row per date", () => {
    const html = `<table>
      <tr><th>Date</th><th>Close</th></tr>
      <tr><td>2026-01-03</td><td>3</td></tr>
      <tr><td>2026-01-01</td><td>1</td></tr>
      <tr><td>2026-01-03</td><td>99</td></tr>
      <tr><td>2026-01-02</td><td>2</td></tr>
    </table>`;
    const table = parseQuoteTable(html, NOW)!;
    expect(table.prices.map((p) => [ymd(p.date), p.close])).toEqual([
      ["2026-01-01", 1],
      ["2026-01-02", 2],
      ["2026-01-03", 3],
    ]);
  });

  it("skips rows whose date or close does not parse, and counts them", () => {
    const html = `<table>
      <tr><td>Fecha</td><td>Cierre</td></tr>
      <tr><td>Total</td><td>12,00</td></tr>
      <tr><td>02/11/2026</td><td>-</td></tr>
      <tr><td>30/10/2026</td><td>10,50</td></tr>
    </table>`;
    const table = parseQuoteTable(html, NOW)!;
    expect(table.prices).toHaveLength(1);
    expect(table.prices[0]).toMatchObject({ close: 10.5 });
    expect(ymd(table.prices[0].date)).toBe("2026-10-30");
    expect(table.skippedRows).toBe(2);
  });

  it("picks the table with the most priced rows and ignores nested tables' rows", () => {
    const html = `
      <table><tr><th>Date</th><th>Close</th></tr><tr><td>2026-01-01</td><td>1</td></tr></table>
      <table>
        <tr><th>Datum</th><th>Schluss</th></tr>
        <tr><td>01.01.2026</td><td>1,5<table><tr><td>02.02.2026</td><td>9</td></tr></table></td></tr>
        <tr><td>02.01.2026</td><td>2,5</td></tr>
      </table>`;
    const table = parseQuoteTable(html, NOW)!;
    expect(table.tableIndex).toBe(1);
    expect(table.prices.map((p) => ymd(p.date))).toEqual([
      "2026-01-01",
      "2026-01-02",
    ]);
  });

  it("lines a colspan header up with the cells under it", () => {
    const html = `<table>
      <tr><th colspan="2">Date</th><th>Close</th></tr>
      <tr><td>Mon</td><td>2026-01-05</td><td>7</td></tr>
    </table>`;
    // The date column is the first of the two it spans; its cell holds a weekday.
    expect(parseQuoteTable(html, NOW)).toBeNull();
    const html2 = `<table>
      <tr><th>Date</th><th colspan="2">Close</th></tr>
      <tr><td>2026-01-05</td><td>7</td><td>x</td></tr>
    </table>`;
    expect(parseQuoteTable(html2, NOW)!.prices[0].close).toBe(7);
  });

  it("returns null for a page with no date-and-close table", () => {
    expect(parseQuoteTable("<p>nothing</p>", NOW)).toBeNull();
    expect(
      parseQuoteTable(
        "<table><tr><th>Name</th><th>Close</th></tr></table>",
        NOW,
      ),
    ).toBeNull();
    expect(
      parseQuoteTable(
        "<table><tr><th>Date</th><th>Close</th></tr></table>",
        NOW,
      ),
    ).toBeNull();
  });
});

describe("mapHeader", () => {
  it("prefers a closing column over a generic price column", () => {
    expect(mapHeader(["Kurs", "Datum", "Schlusskurs"])).toMatchObject({
      date: 1,
      close: 2,
    });
  });

  it("reads Spanish and Portfolio Performance's German names", () => {
    expect(
      mapHeader(["Fecha", "Apertura", "Máximo", "Mínimo", "Cierre", "Volumen"]),
    ).toEqual({ date: 0, open: 1, high: 2, low: 3, close: 4, volume: 5 });
    expect(mapHeader(["Datum", "Rücknahmepreis"])).toEqual({
      date: 0,
      close: 1,
    });
  });

  it("never gives one column to two fields", () => {
    expect(mapHeader(["Date", "Close", "Close"])).toEqual({
      date: 0,
      close: 1,
    });
  });
});

describe("numbers", () => {
  it.each([
    [["3.609,23 €", "3.749,9 €"], ","],
    [["95.69", "95.55"], "."],
    [["1,234.50"], "."],
    [["1.234.567"], ","],
    [["1,234,567"], "."],
    [["12,5"], ","],
    [["1.234", "1,234"], "."],
    [[], "."],
  ])("infers the decimal separator of %j as %s", (samples, expected) => {
    expect(inferDecimalSeparator(samples)).toBe(expected);
  });

  it.each([
    ["3.609,23 €", ",", 3609.23],
    ["1'234.50 CHF", ".", 1234.5],
    ["-2,5 %", ",", -2.5],
    ["6,996", ".", 6996],
    ["7.00k", ".", 7000],
    ["1.2M", ".", 1200000],
    ["-", ",", null],
    ["", ".", null],
    ["n/a", ".", null],
  ] as const)("parses %j with %s as %p", (raw, decimal, expected) => {
    expect(parseNumber(raw, decimal)).toBe(expected);
  });

  it.each([
    ["3.609,23 €", "EUR"],
    ["£12.50", "GBP"],
    ["12.50 USD", "USD"],
    ["$12.50", null],
    ["12.50", null],
  ])("reads the currency of %j as %p", (raw, expected) => {
    expect(detectCurrency(raw)).toBe(expected);
  });
});

describe("dates", () => {
  it.each([
    ["02.11.26", "2026-11-02"],
    ["2.1.2026", "2026-01-02"],
    ["2026-11-02", "2026-11-02"],
    ["Monday, November 02, 2026", "2026-11-02"],
    ["Mon, Nov 02, 2026", "2026-11-02"],
    ["02 Nov 2026", "2026-11-02"],
    ["2. Dezember 2025", "2025-12-02"],
    ["3. Mär. 2025", "2025-03-03"],
    ["2 de noviembre de 2026", "2026-11-02"],
    ["15 ene 2026", "2026-01-15"],
  ])("parses %j", (raw, expected) => {
    expect(ymd(parseDate(raw, true, NOW)!)).toBe(expected);
  });

  it("resolves a two-digit year into the right century", () => {
    expect(ymd(parseDate("01.01.27", true, NOW)!)).toBe("2027-01-01");
    expect(ymd(parseDate("01.01.99", true, NOW)!)).toBe("1999-01-01");
  });

  it("reads slashed dates in the table's own order", () => {
    expect(inferDayFirst(["05/11/2026", "13/10/2026"])).toBe(true);
    expect(inferDayFirst(["11/05/2026", "10/13/2026"])).toBe(false);
    expect(inferDayFirst(["01/02/2026"])).toBe(true);
    expect(ymd(parseDate("10/13/2026", false, NOW)!)).toBe("2026-10-13");
    expect(ymd(parseDate("13/10/2026", true, NOW)!)).toBe("2026-10-13");
  });

  it.each(["31.02.2026", "Total", "Nov 2026", "", "12:30", "2026"])(
    "refuses %j",
    (raw) => {
      expect(parseDate(raw, true, NOW)).toBeNull();
    },
  );
});

describe("hostile pages", () => {
  const timed = (html: string) => {
    const start = Date.now();
    const result = parseQuoteTable(html, NOW);
    return { result, ms: Date.now() - start };
  };

  it("does not spend cubic time on tables nested inside tables", () => {
    const html =
      "<table><tr><td>".repeat(3000) + "</td></tr></table>".repeat(3000);
    const { result, ms } = timed(html);
    expect(result).toBeNull();
    expect(ms).toBeLessThan(1000);
  });

  it("refuses a page nested deeper than any real quote page", () => {
    const html =
      "<table><tr><th>Date</th><th>Close</th></tr><tr><td><div>" +
      "<div>".repeat(900_000) +
      "2026-01-02</td><td>5</td></tr></table>";
    const { result, ms } = timed(html);
    expect(result).toBeNull();
    expect(ms).toBeLessThan(1000);
  });

  it("still reads a long table of unclosed cells and rows", () => {
    const rows = Array.from(
      { length: 3000 },
      (_, i) =>
        `<tr><td>2026-01-${String((i % 28) + 1).padStart(2, "0")}<td>${i + 1}.5`,
    ).join("");
    const result = parseQuoteTable(
      `<table><tr><th>Date<th>Close${rows}</table>`,
      NOW,
    );
    expect(result?.prices.length).toBeGreaterThan(0);
  });
});
