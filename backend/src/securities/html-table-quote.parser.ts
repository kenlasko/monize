import { DomUtils, parseDocument } from "htmlparser2";
import { HistoricalPrice } from "./providers/quote-provider.interface";

/**
 * Reads daily prices out of an ordinary HTML table on a web page: the
 * "table on a website" quote source Portfolio Performance users know.
 *
 * Nothing here is configured per site. The table is found by its header row
 * (a date column and a closing-price column, named in English, German or
 * Spanish), and the date and number formats are inferred from the cells
 * themselves, so the same parser reads `02.11.26` / `3.609,23 €` (ariva.de)
 * and `Monday, November 02, 2026` / `95.69` (markets.ft.com).
 *
 * Pure: no network, no clock except the `now` it is handed (two-digit years
 * are resolved against it).
 */

type Element = ReturnType<typeof DomUtils.getElementsByTagName>[number];

export type QuoteTableField =
  "date" | "close" | "open" | "high" | "low" | "volume";

/**
 * Header patterns per field, best first. A header is trimmed, lower-cased and
 * matched from its start, so "Schluss (EUR)" and "Close*" both match. Where
 * two columns match the same field, the one matching the earlier pattern wins
 * (a "Schluss" column over a "Kurs" column).
 */
const HEADER_PATTERNS: Record<QuoteTableField, RegExp[]> = {
  date: [/^(datum|date|fecha)\b/, /^(handelstag|trading day|día|dia|data)\b/],
  close: [
    /^(schluss|schluß|schlusskurs|close|closing|cierre|chiusura|fechamento)/,
    /^(rücknahmepreis|ruecknahmepreis|valor liquidativo|nav\b|net asset value)/,
    /^(zuletzt|letzter|last|último|ultimo|akt\.? ?kurs)/,
    /^(kurs|price|precio|prezzo|preço|quote)\b/,
  ],
  open: [/^(erster|eröffnung|eroeffnung|open|apertura|abertura)/],
  high: [/^(hoch|tageshoch|high|máx|max|alto|massimo)/],
  low: [/^(tief|tagestief|low|mín|min|bajo|minimo)/],
  volume: [/^(stücke|stueck|volume|volumen|umsatz|vol\b|vol\.)/],
};

const FIELDS = Object.keys(HEADER_PATTERNS) as QuoteTableField[];

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

/** Read the best price table on the page, or `null` when there is none. */
export function parseQuoteTable(
  html: string,
  now: Date = new Date(),
): ParsedQuoteTable | null {
  const document = parseDocument(html, { decodeEntities: true });
  const tables = DomUtils.getElementsByTagName("table", document, true);

  let best: ParsedQuoteTable | null = null;
  tables.forEach((table, index) => {
    const parsed = parseTable(table, index, now);
    if (parsed && (!best || parsed.prices.length > best.prices.length)) {
      best = parsed;
    }
  });
  return best;
}

function parseTable(
  table: Element,
  tableIndex: number,
  now: Date,
): ParsedQuoteTable | null {
  const rows = ownRows(table);
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
  const decimal = inferDecimalSeparator(priceSamples);
  const dayFirst = inferDayFirst(
    dataRows.map((row) => pick(row, "date")[0] ?? ""),
  );

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
      volume: firstParsed(pick(row, "volume"), (s) => parseNumber(s, decimal)),
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

/** The `<tr>`s of this table, not of a table nested inside one of its cells. */
function ownRows(table: Element): Element[] {
  return DomUtils.getElementsByTagName("tr", table, true).filter((row) => {
    let parent = row.parent;
    while (parent && !(isElement(parent) && parent.name === "table")) {
      parent = parent.parent;
    }
    return parent === table;
  });
}

function isElement(node: unknown): node is Element {
  return (
    typeof node === "object" &&
    node !== null &&
    "name" in node &&
    "children" in node
  );
}

/** A row's `<td>`/`<th>` cells, each repeated `colspan` times so indexes line up. */
function expandedCells(row: Element): Element[] {
  const out: Element[] = [];
  for (const child of row.children) {
    if (!isElement(child) || (child.name !== "td" && child.name !== "th"))
      continue;
    const span = Math.min(Math.max(Number(child.attribs?.colspan) || 1, 1), 20);
    for (let i = 0; i < span; i++) out.push(child);
  }
  return out;
}

function normalizeText(text: string): string {
  return text.replace(/[\s\u00a0\u202f]+/g, " ").trim();
}

/** A node's text without that of any table nested inside it. */
function ownText(node: Element): string {
  return node.children
    .map((child) => {
      if (isElement(child)) return child.name === "table" ? "" : ownText(child);
      return DomUtils.textContent(child);
    })
    .join("");
}

function cellText(cell: Element): string {
  return normalizeText(ownText(cell));
}

/**
 * The texts a cell offers, most specific first. A responsive table often
 * writes the same value twice in sibling elements, one shown per screen size
 * (FT: "Monday, November 02, 2026" and "Mon, Nov 02, 2026" in one cell), so
 * each child element's text is tried before the concatenated whole.
 */
function cellCandidates(cell: Element): string[] {
  const parts = cell.children
    .filter(isElement)
    .filter((child) => child.name !== "table")
    .map((child) => normalizeText(ownText(child)))
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

/** Map header texts to the column index of each field, best pattern first. */
export function mapHeader(
  texts: string[],
): Partial<Record<QuoteTableField, number>> {
  const result: Partial<Record<QuoteTableField, number>> = {};
  const taken = new Set<number>();
  for (const field of FIELDS) {
    let bestIndex: number | undefined;
    let bestRank = Infinity;
    texts.forEach((raw, index) => {
      if (taken.has(index)) return;
      const text = raw.toLowerCase();
      if (!text) return;
      const rank = HEADER_PATTERNS[field].findIndex((re) => re.test(text));
      if (rank >= 0 && rank < bestRank) {
        bestRank = rank;
        bestIndex = index;
      }
    });
    if (bestIndex !== undefined) {
      result[field] = bestIndex;
      taken.add(bestIndex);
    }
  }
  return result;
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
export function inferDecimalSeparator(samples: string[]): "." | "," {
  let comma = 0;
  let dot = 0;
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
    }
  }
  return comma > dot ? "," : ".";
}

const MAGNITUDE: Record<string, number> = { k: 1e3, m: 1e6, b: 1e9, bn: 1e9 };

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
  let value = Number(normalized);
  if (!Number.isFinite(value)) return null;
  const suffix = /\d\s*(bn|[kmb])\b/i.exec(raw);
  if (suffix) value *= MAGNITUDE[suffix[1].toLowerCase()];
  return value;
}

/** The currency a price cell names, when it names one unambiguously. */
export function detectCurrency(raw: string): string | null {
  if (raw.includes("€")) return "EUR";
  if (raw.includes("£")) return "GBP";
  const iso = /(?:^|[^A-Za-z])([A-Z]{3})(?:$|[^A-Za-z])/.exec(raw);
  return iso ? iso[1] : null;
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
 * part above 12 proves it does, a second part above 12 proves it does not;
 * with no evidence either way the European order is assumed. Dotted dates
 * are always day first and do not vote.
 */
export function inferDayFirst(samples: string[]): boolean {
  for (const sample of samples) {
    const match = /^(\d{1,2})[/-](\d{1,2})[/-]\d{2,4}$/.exec(sample.trim());
    if (!match) continue;
    if (Number(match[1]) > 12) return true;
    if (Number(match[2]) > 12) return false;
  }
  return true;
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
  const tokens = text
    .toLowerCase()
    .replace(WEEKDAYS, " ")
    .replace(/\bde\b/g, " ")
    .split(/[\s,./-]+/)
    .filter(Boolean);
  let month: number | undefined;
  const numbers: string[] = [];
  for (const token of tokens) {
    if (/^\d+$/.test(token)) numbers.push(token);
    else if (MONTHS[token] !== undefined && month === undefined)
      month = MONTHS[token];
    else return null;
  }
  if (month === undefined || numbers.length !== 2) return null;
  const yearToken = numbers.find((n) => n.length === 4) ?? numbers[1];
  const dayToken = numbers.find((n) => n !== yearToken) ?? numbers[0];
  return utcDate(fullYear(Number(yearToken), now), month, Number(dayToken));
}
