import { readFileSync } from "fs";
import { join } from "path";
import {
  AmbiguousQuoteTableError,
  headerSeparatorHint,
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

  it.each([
    [
      "French",
      ["Date", "Ouverture", "Plus haut", "Plus bas", "Clôture", "Volume"],
    ],
    [
      "Italian",
      ["Data", "Apertura", "Massimo", "Minimo", "Chiusura", "Volume"],
    ],
    ["Portuguese", ["Data", "Abertura", "Máxima", "Mínima", "Fecho", "Volume"]],
    ["Dutch", ["Datum", "Open", "Hoog", "Laag", "Slot", "Volume"]],
    [
      "Polish",
      ["Data", "Otwarcie", "Najwyższy", "Najniższy", "Zamknięcie", "Wolumen"],
    ],
    [
      "Russian",
      ["Дата", "Открытие", "Максимум", "Минимум", "Закрытие", "Объём"],
    ],
    [
      "Ukrainian",
      ["Дата", "Відкриття", "Максимум", "Мінімум", "Закриття", "Обсяг"],
    ],
    [
      "Turkish",
      ["TARİH", "AÇILIŞ", "EN YÜKSEK", "EN DÜŞÜK", "KAPANIŞ", "HACİM"],
    ],
    [
      "Vietnamese",
      ["Ngày", "Mở cửa", "Cao nhất", "Thấp nhất", "Đóng cửa", "Khối lượng"],
    ],
    [
      "Indonesian",
      ["Tanggal", "Pembukaan", "Tertinggi", "Terendah", "Penutupan", "Volume"],
    ],
    ["Hindi", ["तारीख", "खुला", "उच्च", "निम्न", "बंद", "वॉल्यूम"]],
    ["Japanese", ["日付", "始値", "高値", "安値", "終値", "出来高"]],
    ["Korean", ["날짜", "시가", "고가", "저가", "종가", "거래량"]],
    [
      "Simplified Chinese",
      ["日期", "开盘价", "最高价", "最低价", "收盘价", "成交量"],
    ],
    [
      "Traditional Chinese",
      ["日期", "開盤價", "最高價", "最低價", "收盤價", "成交量"],
    ],
  ])("reads %s names", (_language, headers) => {
    expect(mapHeader(headers)).toEqual({
      date: 0,
      open: 1,
      high: 2,
      low: 3,
      close: 4,
      volume: 5,
    });
  });

  it("reads a price noun followed by which price it is", () => {
    expect(
      mapHeader([
        "Date",
        "Cours d'ouverture",
        "Cours le plus haut",
        "Cours le plus bas",
        "Cours de clôture",
      ]),
    ).toEqual({ date: 0, open: 1, high: 2, low: 3, close: 4 });
    expect(
      mapHeader(["Date", "Cours le plus haut", "Cours le plus bas", "Cours"]),
    ).toEqual({ date: 0, high: 1, low: 2, close: 3 });
    expect(mapHeader(["Дата", "Цена открытия", "Цена закрытия"])).toEqual({
      date: 0,
      open: 1,
      close: 2,
    });
    expect(
      mapHeader(["Ngày", "Giá mở cửa", "Giá cao nhất", "Giá đóng cửa"]),
    ).toEqual({ date: 0, open: 1, high: 2, close: 3 });
  });

  it("does not take another price's column as a generic close", () => {
    expect(mapHeader(["Data", "Kurs otwarcia", "Kurs max"])).toEqual({
      date: 0,
      open: 1,
      high: 2,
    });
    expect(mapHeader(["Data", "Kurs otwarcia", "Kurs"])).toEqual({
      date: 0,
      open: 1,
      close: 2,
    });
  });

  it("reads a header whose accents are written as combining marks", () => {
    const decomposed = "Clôture".normalize("NFD");
    expect(mapHeader(["Date", decomposed])).toEqual({ date: 0, close: 1 });
    expect(headerSeparatorHint(["Date", decomposed])).toBe(",");
  });

  it("ends a word at a non-ASCII letter", () => {
    expect(mapHeader(["Data", "Preço"])).toEqual({ date: 0, close: 1 });
    expect(mapHeader(["Дата", "Цена"])).toEqual({ date: 0, close: 1 });
  });

  it("leaves adjusted closes and market value alone", () => {
    expect(mapHeader(["日付", "調整後終値", "終値"])).toEqual({
      date: 0,
      close: 2,
    });
    expect(mapHeader(["날짜", "시가총액", "종가"])).toEqual({
      date: 0,
      close: 2,
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
    [["1.234", "1,234"], null],
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
    // 4.06 * 1e6 is 4059999.9999999995 in floating point; a bigint column
    // refuses it (PR #1995, found on ariva.de).
    ["4.06 m", ".", 4060000],
    ["4,06 m", ",", 4060000],
    ["1.15 bn", ".", 1150000000],
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
    expect(inferDayFirst(["01/02/2026"])).toBeNull();
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

  // The pages of PR #1995's second review, at the 5 MB the download allows:
  // each held the event loop for seconds to minutes through the DOM builder,
  // the streaming Parser or the regex pre-scan, so each is timed here.
  const PRICE_TABLE =
    "<table><tr><th>Date</th><th>Close</th></tr>" +
    "<tr><td>2026-11-02</td><td>5.10</td></tr></table>";
  const fill = (unit: string) =>
    unit.repeat(Math.floor((5 * 1024 * 1024) / unit.length));

  it.each([
    ["repeated <thead>", "<thead>"],
    ["repeated <tfoot>", "<tfoot>"],
    ["stray closing tags", "<div></span>"],
    ["unclosed divs", "<div>"],
    ["nested tables", "<table><tr><td>"],
    ["unclosed cells", "<td><b>"],
  ])("reads the table after 5 MB of %s in linear time", (_name, unit) => {
    const { result, ms } = timed(fill(unit) + PRICE_TABLE);
    expect(ms).toBeLessThan(2000);
    // Inside unclosed nested tables the price table is a nested one; outside
    // them it is read as the page's table either way.
    if (unit !== "<table><tr><td>") {
      expect(result?.prices.map((p) => p.close)).toEqual([5.1]);
    }
  });

  it.each([
    ["an unterminated tag", "<a "],
    ["an unterminated comment", "<!--"],
    ["an unterminated script", "<script>"],
    ["bare angle brackets", "<"],
    ["unterminated entities", "&amp"],
    ["an unterminated colspan", '<td colspan="'],
  ])("is linear on 5 MB of %s", (_name, unit) => {
    const { ms } = timed(fill(unit) + PRICE_TABLE);
    expect(ms).toBeLessThan(2000);
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

describe("readings the page does not settle", () => {
  it("does not take 102,345 for 102345 unless the page groups thousands", () => {
    expect(inferDecimalSeparator(["102,345", "101,998", "103,120"])).toBeNull();
    expect(inferDecimalSeparator(["102,345", "101,998"], ",")).toBe(",");
    expect(inferDecimalSeparator(["102,345", "101,5"])).toBe(",");
    expect(inferDecimalSeparator(["1,102,345", "98"])).toBe(".");
  });

  it("refuses a table whose prices all read both ways, and reads it with a dotted date", () => {
    const page = (date: string, headers = "<th>Fecha</th><th>Cierre</th>") =>
      `<table><tr>${headers}</tr>` +
      `<tr><td>${date}</td><td>102,345</td></tr>` +
      `<tr><td>${date}</td><td>101,998</td></tr></table>`;
    // Spanish headers do not say which separator (Spain and Mexico differ).
    expect(() => parseQuoteTable(page("2026-11-02"), NOW)).toThrow(
      AmbiguousQuoteTableError,
    );
    // An English page groups thousands with the comma.
    expect(
      parseQuoteTable(
        page("2026-11-02", "<th>Date</th><th>Close</th>"),
        NOW,
      )!.prices.map((p) => p.close),
    ).toEqual([102345]);
    const rows = (d1: string, d2: string) =>
      `<table><tr><th>Datum</th><th>Schluss</th></tr>` +
      `<tr><td>${d1}</td><td>102,345</td></tr>` +
      `<tr><td>${d2}</td><td>101,998</td></tr></table>`;
    const table = parseQuoteTable(rows("02.11.2026", "30.10.2026"), NOW);
    expect(table!.prices.map((p) => p.close)).toEqual([101.998, 102.345]);
  });

  it("reads US short dates by the order of the rows, not by default", () => {
    expect(inferDayFirst(["11/02/2026", "11/03/2026", "11/04/2026"])).toBe(
      false,
    );
    expect(inferDayFirst(["02/11/2026", "03/11/2026", "04/11/2026"])).toBe(
      true,
    );
    expect(inferDayFirst(["01/11/2026", "01/12/2026", "01/01/2027"])).toBe(
      true,
    );
    expect(inferDayFirst(["01/02/2026", "03/04/2026"])).toBeNull();
    expect(
      inferDayFirst(["03/04/2026", "01/02/2026", "05/06/2026"]),
    ).toBeNull();
  });

  it("refuses a table of dates it cannot place", () => {
    const html =
      "<table><tr><th>Date</th><th>Close</th></tr>" +
      "<tr><td>01/02/2026</td><td>5.10</td></tr></table>";
    expect(() => parseQuoteTable(html, NOW)).toThrow(AmbiguousQuoteTableError);
  });

  it("reads the US table that was once read as February", () => {
    const html =
      "<table><tr><th>Date</th><th>Close</th></tr>" +
      "<tr><td>11/04/2026</td><td>5.30</td></tr>" +
      "<tr><td>11/03/2026</td><td>5.20</td></tr>" +
      "<tr><td>11/02/2026</td><td>5.10</td></tr></table>";
    expect(parseQuoteTable(html, NOW)!.prices.map((p) => ymd(p.date))).toEqual([
      "2026-11-02",
      "2026-11-03",
      "2026-11-04",
    ]);
  });
});

describe("currency labels", () => {
  it.each(["NAV 12.34", "EST 12.34", "TTM 4", "N/A", "$12.34"])(
    "does not take %j for a currency",
    (raw) => {
      expect(detectCurrency(raw)).toBeNull();
    },
  );

  it.each([
    ["USD 12.34", "USD"],
    ["12.34 CHF", "CHF"],
    ["NAV 12.34 EUR", "EUR"],
  ])("reads %j as %s", (raw, code) => {
    expect(detectCurrency(raw)).toBe(code);
  });
});

describe("script, style and comment bodies are text, not nesting", () => {
  const price =
    "<table><tr><th>Date</th><th>Close</th></tr>" +
    "<tr><td>2026-11-02</td><td>5.10</td></tr></table>";

  it.each([
    ["script", `<script>var t='${"<div>".repeat(600)}';</script>`],
    ["style", `<style>/* ${"<div>".repeat(600)} */</style>`],
    ["comment", `<!-- ${"<div>".repeat(600)} -->`],
  ])("a %s holding 600 open tags does not refuse the page", (_n, body) => {
    expect(parseQuoteTable(`<html>${body}${price}</html>`, NOW)).not.toBeNull();
  });

  it("reads a table after 600 real nested elements", () => {
    expect(
      parseQuoteTable(`${"<div>".repeat(600)}${price}`, NOW),
    ).not.toBeNull();
  });

  it("does not read a script's markup as a table", () => {
    const fake =
      "<script>var t='<table><tr><th>Date</th><th>Close</th></tr>" +
      "<tr><td>2026-11-01</td><td>99</td></tr></table>';</script>";
    expect(
      parseQuoteTable(`<html>${fake}${price}</html>`, NOW)!.prices.map(
        (p) => p.close,
      ),
    ).toEqual([5.1]);
  });

  it("scans unclosed scripts in linear time", () => {
    const start = Date.now();
    parseQuoteTable("<script>".repeat(200_000), NOW);
    expect(Date.now() - start).toBeLessThan(1000);
  });
});

describe("a lone dot before three digits", () => {
  const page = (date: string, close: string) =>
    `<table><tr><th>${date}</th><th>${close}</th></tr>` +
    `<tr><td>2026-11-02</td><td>12.345</td></tr>` +
    `<tr><td>2026-10-30</td><td>1.234</td></tr></table>`;

  it("is read as thousands on a German page with ISO dates", () => {
    expect(
      parseQuoteTable(page("Datum", "Schluss"), NOW)!.prices.map(
        (p) => p.close,
      ),
    ).toEqual([1234, 12345]);
  });

  it("is read as a decimal on an English page", () => {
    expect(
      parseQuoteTable(page("Date", "Close"), NOW)!.prices.map((p) => p.close),
    ).toEqual([1.234, 12.345]);
  });

  it("is refused on a page whose headers do not say (Spanish is written both ways)", () => {
    expect(() => parseQuoteTable(page("Fecha", "Cierre"), NOW)).toThrow(
      AmbiguousQuoteTableError,
    );
  });

  it("is settled by the other prices when they show the separator", () => {
    expect(inferDecimalSeparator(["12.345", "12.5"])).toBe(".");
    expect(inferDecimalSeparator(["12.345", "12,5"])).toBe(",");
    expect(inferDecimalSeparator(["12.345"])).toBeNull();
  });

  it("takes the header language only when the headers agree", () => {
    expect(headerSeparatorHint(["Date", "Close"])).toBe(".");
    expect(headerSeparatorHint(["Datum", "Schlusskurs"])).toBe(",");
    expect(headerSeparatorHint(["Fecha", "Cierre"])).toBeNull();
    expect(headerSeparatorHint(["Datum", "Close"])).toBeNull();
  });

  it("takes the separator from every translated language but Spanish", () => {
    expect(headerSeparatorHint(["Date", "Clôture"])).toBe(",");
    expect(headerSeparatorHint(["Datum", "Slot"])).toBe(",");
    expect(headerSeparatorHint(["Data", "Zamknięcie"])).toBe(",");
    expect(headerSeparatorHint(["Дата", "Закрытие"])).toBe(",");
    expect(headerSeparatorHint(["TARİH", "KAPANIŞ"])).toBe(",");
    expect(headerSeparatorHint(["Ngày", "Đóng cửa"])).toBe(",");
    expect(headerSeparatorHint(["Tanggal", "Penutupan"])).toBe(",");
    expect(headerSeparatorHint(["日付", "終値"])).toBe(".");
    expect(headerSeparatorHint(["날짜", "종가"])).toBe(".");
    expect(headerSeparatorHint(["日期", "收盘价"])).toBe(".");
    expect(headerSeparatorHint(["तारीख", "बंद"])).toBe(".");
    expect(headerSeparatorHint(["Date"])).toBeNull();
  });
});

describe("a volume column", () => {
  it("stores a volume as a whole number, never a fractional count", () => {
    const html = `<table><tr><th>Datum</th><th>Schluss</th><th>Vol. (nom.)</th></tr>
      <tr><td>05.11.2026</td><td>113,95</td><td>4,06 m</td></tr>
      <tr><td>04.11.2026</td><td>113,54</td><td>1,5</td></tr></table>`;
    const quotes = parseQuoteTable(html, new Date("2026-11-06T00:00:00Z"));
    expect(quotes?.prices.map((r) => r.volume)).toEqual([2, 4060000]);
  });
});
