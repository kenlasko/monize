import { isKnownIsoCurrency } from "../currencies/currency-metadata";
import { HistoricalPrice } from "./providers/quote-provider.interface";
import { PageCell, PageTable, readPageTables } from "./html-table-reader";
import {
  FIELDS,
  QuoteTableField,
  headerSeparatorHint,
  mapHeader,
} from "./html-table-quote.headers";

export { headerSeparatorHint, mapHeader };
export type { QuoteTableField };

/**
 * Reads daily prices out of an ordinary HTML table on a web page: the
 * "table on a website" quote source Portfolio Performance users know.
 *
 * Nothing here is configured per site. The table is found by its header row
 * (a date column and a closing-price column, named in any language Monize
 * is translated into; `html-table-quote.headers.ts`), and the date and number
 * formats are inferred from the cells themselves, so the same parser reads `02.11.26` / `3.609,23 €` (ariva.de)
 * and `Monday, November 02, 2026` / `95.69` (markets.ft.com).
 *
 * Pure: no network, no clock except the `now` it is handed (two-digit years
 * are resolved against it).
 */

/** Rows scanned for the header before a table is given up on. */
const MAX_HEADER_SCAN_ROWS = 3;

export interface ParsedQuoteTable {
  /** Daily bars, oldest first, one per date. */
  prices: HistoricalPrice[];
  /**
   * The currency the closing prices are written in, when the cells say so
   * unambiguously (`€`, `£`, or an ISO code beside the number); `null` when
   * they do not. A bare `$` is not read as USD.
   */
  currencyCode: string | null;
  /** The header text of each column used, for the preview and the logs. */
  columns: Partial<Record<QuoteTableField, string>>;
  /** Which `<table>` on the page, counted from 0, the rows came from. */
  tableIndex: number;
  /** Data rows skipped because their date or close did not parse. */
  skippedRows: number;
}

/**
 * A table whose numbers or dates can be read in more than one way, with nothing
 * on the page to say which. Guessing stores a price a thousand times too large
 * or a date in the wrong month, so the page is refused instead.
 */
export class AmbiguousQuoteTableError extends Error {
  constructor(readonly what: "numbers" | "dates") {
    super(`The table's ${what} can be read in more than one way`);
    this.name = "AmbiguousQuoteTableError";
  }
}

/** Read the best price table on the page, or `null` when there is none. */
export function parseQuoteTable(
  html: string,
  now: Date = new Date(),
): ParsedQuoteTable | null {
  const tables = readPageTables(html);

  let best: ParsedQuoteTable | null = null;
  let ambiguous: AmbiguousQuoteTableError | null = null;
  tables.forEach((table, index) => {
    try {
      const parsed = parseTable(table, index, now);
      if (parsed && (!best || parsed.prices.length > best.prices.length)) {
        best = parsed;
      }
    } catch (error) {
      // One table that cannot be read safely does not hide another that can.
      if (!(error instanceof AmbiguousQuoteTableError)) throw error;
      ambiguous ??= error;
    }
  });
  if (!best && ambiguous) throw ambiguous;
  return best;
}

function parseTable(
  table: PageTable,
  tableIndex: number,
  now: Date,
): ParsedQuoteTable | null {
  const rows = table.rows;
  let headerRow = -1;
  let columns: Partial<Record<QuoteTableField, number>> = {};
  let headerTexts: string[] = [];

  for (let i = 0; i < Math.min(rows.length, MAX_HEADER_SCAN_ROWS); i++) {
    const texts = expandedCells(rows[i]).map((cell) => cellText(cell));
    const mapped = mapHeader(texts);
    if (mapped.date !== undefined && mapped.close !== undefined) {
      headerRow = i;
      columns = mapped;
      headerTexts = texts;
      break;
    }
  }
  if (headerRow < 0) return null;

  const dataRows = rows
    .slice(headerRow + 1)
    .map((row) => expandedCells(row).map((cell) => cellCandidates(cell)));

  const pick = (row: string[][], field: QuoteTableField): string[] => {
    const index = columns[field];
    return index === undefined ? [] : (row[index] ?? []);
  };

  const priceSamples = dataRows.flatMap((row) =>
    (["close", "open", "high", "low"] as const).map(
      (f) => pick(row, f)[0] ?? "",
    ),
  );
  const dateSamples = dataRows.map((row) => pick(row, "date")[0] ?? "");
  // A dotted date (02.11.2026) is the continental way of writing it, and the
  // same pages write 102,345 for a price with three decimals.
  const continental = dateSamples.some((d) =>
    /^\d{1,2}\.\d{1,2}\.\d{2,4}$/.test(d.trim()),
  );
  const decimal = inferDecimalSeparator(
    priceSamples,
    continental
      ? ","
      : headerSeparatorHint([
          headerTexts[columns.date ?? -1] ?? "",
          headerTexts[columns.close ?? -1] ?? "",
        ]),
  );
  const dayFirst = inferDayFirst(dateSamples);
  if (decimal === null) throw new AmbiguousQuoteTableError("numbers");
  if (dayFirst === null) throw new AmbiguousQuoteTableError("dates");

  const byDate = new Map<number, HistoricalPrice>();
  let skippedRows = 0;
  let currencyCode: string | null = null;

  for (const row of dataRows) {
    if (row.length === 0) continue;
    const date = firstParsed(pick(row, "date"), (s) =>
      parseDate(s, dayFirst, now),
    );
    const close = firstParsed(pick(row, "close"), (s) =>
      parseNumber(s, decimal),
    );
    if (!date || close === null || close <= 0) {
      skippedRows++;
      continue;
    }
    currencyCode ??= detectCurrency(pick(row, "close")[0] ?? "");
    const key = date.getTime();
    if (byDate.has(key)) continue;
    byDate.set(key, {
      date,
      open: firstParsed(pick(row, "open"), (s) => parseNumber(s, decimal)),
      high: firstParsed(pick(row, "high"), (s) => parseNumber(s, decimal)),
      low: firstParsed(pick(row, "low"), (s) => parseNumber(s, decimal)),
      close,
      adjClose: null,
      volume: firstParsed(pick(row, "volume"), (s) => {
        const shares = parseNumber(s, decimal);
        // security_prices.volume is a bigint: a count is a whole number.
        return shares === null ? null : Math.round(shares);
      }),
    });
  }

  if (byDate.size === 0) return null;

  const labels: Partial<Record<QuoteTableField, string>> = {};
  for (const field of FIELDS) {
    const index = columns[field];
    if (index !== undefined) labels[field] = headerTexts[index];
  }

  return {
    prices: [...byDate.values()].sort(
      (a, b) => a.date.getTime() - b.date.getTime(),
    ),
    currencyCode,
    columns: labels,
    tableIndex,
    skippedRows,
  };
}

/** A row's cells, each repeated `colspan` times so indexes line up. */
function expandedCells(row: PageCell[]): PageCell[] {
  const out: PageCell[] = [];
  for (const cell of row) {
    for (let i = 0; i < cell.span; i++) out.push(cell);
  }
  return out;
}

function normalizeText(text: string): string {
  return text.replace(/[\s\u00a0\u202f]+/g, " ").trim();
}

function cellText(cell: PageCell): string {
  return normalizeText(cell.text);
}

/**
 * The texts a cell offers, most specific first. A responsive table often
 * writes the same value twice in sibling elements, one shown per screen size
 * (FT: "Monday, November 02, 2026" and "Mon, Nov 02, 2026" in one cell), so
 * each child element's text is tried before the concatenated whole.
 */
function cellCandidates(cell: PageCell): string[] {
  const parts = cell.parts
    .map((part) => normalizeText(part))
    .filter((text) => text.length > 0);
  const whole = cellText(cell);
  return parts.length > 1 ? [...parts, whole] : [whole];
}

function firstParsed<T>(
  candidates: string[],
  parse: (s: string) => T | null,
): T | null {
  for (const candidate of candidates) {
    const value = parse(candidate);
    if (value !== null) return value;
  }
  return null;
}

// ---------------------------------------------------------------- numbers

/** The numeric part of a cell: digits, separators and a sign. */
function numericCore(raw: string): string {
  const match = /[-+\u2212]?\d[\d.,'\u2019\s\u00a0\u202f]*/.exec(raw);
  return match
    ? match[0].replace(/[\s\u00a0\u202f'\u2019]/g, "").replace(/[.,]$/, "")
    : "";
}

/**
 * Which character is the decimal separator in this table, decided by vote
 * over every price cell. A cell with both separators votes for the last one;
 * a single separator followed by anything other than three digits is a
 * decimal point; repeated separators are thousands. Ties and an empty vote
 * fall back to ".".
 */
export function inferDecimalSeparator(
  samples: string[],
  hint: "." | "," | null = null,
): "." | "," | null {
  let comma = 0;
  let dot = 0;
  let ambiguousComma = 0;
  let ambiguousDot = 0;
  for (const sample of samples) {
    const core = numericCore(sample);
    const lastDot = core.lastIndexOf(".");
    const lastComma = core.lastIndexOf(",");
    if (lastDot >= 0 && lastComma >= 0) {
      if (lastComma > lastDot) comma++;
      else dot++;
      continue;
    }
    const sep = lastComma >= 0 ? "," : lastDot >= 0 ? "." : null;
    if (!sep) continue;
    const occurrences = core.split(sep).length - 1;
    const after = core.length - core.lastIndexOf(sep) - 1;
    const isDecimal = occurrences === 1 && after !== 3;
    const isThousands = occurrences > 1;
    if (isDecimal) {
      if (sep === ",") comma++;
      else dot++;
    } else if (isThousands) {
      if (sep === ",") dot++;
      else comma++;
    } else if (sep === ",") {
      // One comma and three digits after it: 102,345 is 102.345 on a page
      // that writes decimals with a comma and 102345 on one that groups
      // thousands with it.
      ambiguousComma++;
    } else {
      // The mirror case: 12.345 is a three-decimal price on a US page and
      // 12345 on a continental one that groups thousands with a dot.
      ambiguousDot++;
    }
  }
  if (comma !== dot) return comma > dot ? "," : ".";
  if (hint) return hint;
  return ambiguousComma > 0 || ambiguousDot > 0 ? null : ".";
}

/** Decimal exponent of each magnitude suffix: k = 10^3, m = 10^6, b = 10^9. */
const MAGNITUDE: Record<string, number> = { k: 3, m: 6, b: 9, bn: 9 };

/** Parse a cell as a number, or `null` for an empty, dashed or non-numeric cell. */
export function parseNumber(raw: string, decimal: "." | ","): number | null {
  const core = numericCore(raw);
  if (!/\d/.test(core)) return null;
  const thousands = decimal === "," ? "." : ",";
  const normalized = core
    .split(thousands)
    .join("")
    .replace(decimal, ".")
    .replace("\u2212", "-");
  const suffix = /\d\s*(bn|[kmb])\b/i.exec(raw);
  // The magnitude goes in as an exponent: 4.06 * 1e6 is 4059999.9999999995,
  // while Number("4.06e6") is exactly 4060000.
  const exponent = suffix ? MAGNITUDE[suffix[1].toLowerCase()] : 0;
  const value = Number(exponent ? `${normalized}e${exponent}` : normalized);
  return Number.isFinite(value) ? value : null;
}

/** The currency a price cell names, when it names one unambiguously. */
export function detectCurrency(raw: string): string | null {
  if (raw.includes("€")) return "EUR";
  if (raw.includes("£")) return "GBP";
  // Any three capitals look like a code ("NAV", "EST", "TTM"); only a real ISO
  // 4217 code is a currency, or every refresh would be refused over a label.
  for (const m of raw.matchAll(/(?:^|[^A-Za-z])([A-Z]{3})(?=$|[^A-Za-z])/g)) {
    if (isKnownIsoCurrency(m[1])) return m[1];
  }
  return null;
}

// ------------------------------------------------------------------ dates

const MONTHS: Record<string, number> = {};
const MONTH_NAMES: Array<[number, string[]]> = [
  [1, ["january", "jan", "januar", "jänner", "jaenner", "enero", "ene"]],
  [2, ["february", "feb", "februar", "febrero"]],
  [3, ["march", "mar", "märz", "maerz", "mär", "mrz", "marzo"]],
  [4, ["april", "apr", "abril", "abr"]],
  [5, ["may", "mai", "mayo"]],
  [6, ["june", "jun", "juni", "junio"]],
  [7, ["july", "jul", "juli", "julio"]],
  [8, ["august", "aug", "agosto", "ago"]],
  [9, ["september", "sep", "sept", "septiembre", "setiembre"]],
  [10, ["october", "oct", "oktober", "okt", "octubre"]],
  [11, ["november", "nov", "noviembre"]],
  [12, ["december", "dec", "dezember", "dez", "diciembre", "dic"]],
];
for (const [month, names] of MONTH_NAMES) {
  for (const name of names) MONTHS[name] = month;
}

const WEEKDAYS =
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo)\b\.?/g;

/**
 * Whether numeric `a/b/yyyy` dates in this table put the day first. A first
 * part above 12 proves it does, a second part above 12 proves it does not.
 * With no such date the table's own order decides (see below), and `null`
 * means the page does not say. Dotted dates are always day first and do not
 * vote.
 */
export function inferDayFirst(samples: string[]): boolean | null {
  const slashed: Array<[number, number, number]> = [];
  for (const sample of samples) {
    const match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(
      sample.trim(),
    );
    if (!match) continue;
    const [first, second] = [Number(match[1]), Number(match[2])];
    if (first > 12) return true;
    if (second > 12) return false;
    slashed.push([first, second, Number(match[3])]);
  }
  if (slashed.length === 0) return true;

  // Every date reads either way. A price history is in date order, so the
  // reading that puts the rows in order is the right one. When both do, the
  // reading that keeps them close together is: rows are consecutive sessions,
  // not a year apart. Anything the page does not settle (01/02/2026 alone,
  // or two readings equally plausible) is refused rather than guessed.
  const read = (dayFirst: boolean): { ordered: boolean; span: number } => {
    const days = slashed.map(([a, b, y]) =>
      Date.UTC(
        fullYear(y, new Date()),
        (dayFirst ? b : a) - 1,
        dayFirst ? a : b,
      ),
    );
    let sign = 0;
    let span = 0;
    let ordered = true;
    for (let i = 1; i < days.length; i++) {
      const step = Math.sign(days[i] - days[i - 1]);
      span += Math.abs(days[i] - days[i - 1]);
      if (step === 0) continue;
      if (sign !== 0 && step !== sign) ordered = false;
      sign = step;
    }
    return { ordered, span };
  };
  const dayFirst = read(true);
  const monthFirst = read(false);
  if (dayFirst.ordered !== monthFirst.ordered) return dayFirst.ordered;
  if (!dayFirst.ordered || slashed.length < 3) return null;
  if (dayFirst.span * 2 <= monthFirst.span) return true;
  if (monthFirst.span * 2 <= dayFirst.span) return false;
  return null;
}

function fullYear(year: number, now: Date): number {
  if (year >= 100) return year;
  const candidate = 2000 + year;
  return candidate <= now.getUTCFullYear() + 1 ? candidate : 1900 + year;
}

function utcDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCMonth() === month - 1 ? date : null;
}

/** Parse a date cell to UTC midnight, or `null` when it is not a date. */
export function parseDate(
  raw: string,
  dayFirst: boolean,
  now: Date,
): Date | null {
  const text = raw.trim();
  if (!text) return null;

  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/.exec(text);
  if (m) return utcDate(Number(m[1]), Number(m[2]), Number(m[3]));

  m = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(text);
  if (m)
    return utcDate(fullYear(Number(m[3]), now), Number(m[2]), Number(m[1]));

  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/.exec(text);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    const year = fullYear(Number(m[3]), now);
    return dayFirst ? utcDate(year, b, a) : utcDate(year, a, b);
  }

  // Textual: "Monday, November 02, 2026", "02 Nov 2026", "2. November 2026",
  // "2 de noviembre de 2026".
  const words = text
    .toLowerCase()
    .replace(WEEKDAYS, " ")
    .replace(/\bde\b/g, " ")
    .split(/[\s,./-]+/)
    .filter(Boolean);
  let month: number | undefined;
  const numbers: string[] = [];
  for (const word of words) {
    if (/^\d+$/.test(word)) numbers.push(word);
    else if (MONTHS[word] !== undefined && month === undefined)
      month = MONTHS[word];
    else return null;
  }
  if (month === undefined || numbers.length !== 2) return null;
  const yearDigits = numbers.find((n) => n.length === 4) ?? numbers[1];
  const dayDigits = numbers.find((n) => n !== yearDigits) ?? numbers[0];
  return utcDate(fullYear(Number(yearDigits), now), month, Number(dayDigits));
}
