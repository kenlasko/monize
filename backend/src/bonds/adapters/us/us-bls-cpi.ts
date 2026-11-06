import {
  BenchmarkFetchError,
  BenchmarkFetchResult,
  BenchmarkObservation,
  BondFetch,
} from "../../bond-adapter";
import { daysInMonth } from "../../domain/calendar-date";
import { ExactDecimal } from "../../domain/exact-decimal";

/** The only host the CPI fetch talks to. */
export const BLS_HOST = "api.bls.gov";
/** CPI-U, U.S. city average, all items, not seasonally adjusted. */
export const BLS_CPI_SERIES = "CUUR0000SA0";
export const BLS_CPI_LANDING_URL =
  "https://data.bls.gov/timeseries/CUUR0000SA0";
/** The public API serves ten years of a series per request without a key. */
export const BLS_YEARS = 10;
const MAX_BYTES = 1024 * 1024;
const LEVEL = /^\d{1,5}(?:\.\d{1,6})?$/;
const PERIOD = /^M(0[1-9]|1[0-2])$/;

export function blsCpiUrl(startYear: number, endYear: number): string {
  return `https://${BLS_HOST}/publicAPI/v2/timeseries/data/${BLS_CPI_SERIES}?startyear=${startYear}&endyear=${endYear}`;
}

function refuse(reason: string): BenchmarkFetchError {
  return new BenchmarkFetchError(`BLS CPI: ${reason}`);
}

function objectOf(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw refuse(`${what} is not an object`);
  }
  return value as Record<string, unknown>;
}

function text(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== "string") throw refuse(`${field} is not a string`);
  return value.trim();
}

/**
 * The observations of a BLS API answer, one per month, dated the first of the
 * month, the level as published ("335.123"). The annual average (`M13`) is not a
 * month and is skipped; a month the BLS marks unavailable (`-`) is skipped, never
 * read as zero (INV-BOND-002). Anything else that is not a positive decimal, a
 * second row of one month or a period that is not a month is refused.
 */
export function parseBlsCpi(
  body: string,
  today: string,
): BenchmarkObservation[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw refuse("the answer is not JSON");
  }
  const root = objectOf(parsed, "the answer");
  if (root.status !== "REQUEST_SUCCEEDED") {
    throw refuse(`the request did not succeed (${String(root.status)})`);
  }
  const results = objectOf(root.Results, "Results");
  const series = results.series;
  if (!Array.isArray(series) || series.length !== 1) {
    throw refuse("Results.series is not one series");
  }
  const first = objectOf(series[0], "the series");
  if (first.seriesID !== BLS_CPI_SERIES) {
    throw refuse(`the series is ${String(first.seriesID)}`);
  }
  if (!Array.isArray(first.data)) throw refuse("the series has no data array");
  const thisMonth = today.slice(0, 7);
  const byDate = new Map<string, BenchmarkObservation>();
  for (const item of first.data) {
    const row = objectOf(item, "a data row");
    const period = text(row, "period");
    if (period === "M13") continue;
    const match = PERIOD.exec(period);
    const year = text(row, "year");
    if (!match || !/^\d{4}$/.test(year)) {
      throw refuse(`malformed period ${year} ${period}`);
    }
    const month = `${year}-${match[1]}`;
    if (month > thisMonth) throw refuse(`${month} is after ${today}`);
    const value = text(row, "value");
    if (value === "-") continue;
    if (!LEVEL.test(value) || ExactDecimal.parse(value).isZero()) {
      throw refuse(`malformed level for ${month}`);
    }
    const observationDate = `${month}-01`;
    if (byDate.has(observationDate)) {
      throw refuse(`duplicate row for ${month}`);
    }
    byDate.set(observationDate, {
      observationDate,
      value: ExactDecimal.parse(value).toTrimmedString(6, 0),
      publishedOn: null,
    });
  }
  if (byDate.size === 0) throw refuse("no usable rows");
  return [...byDate.values()].sort((a, b) =>
    a.observationDate.localeCompare(b.observationDate),
  );
}

/** The last day of the month of `observationDate`: the level covers its whole month. */
function endOfMonth(observationDate: string): string {
  const year = Number(observationDate.slice(0, 4));
  const month = Number(observationDate.slice(5, 7));
  return `${observationDate.slice(0, 7)}-${String(daysInMonth(year, month)).padStart(2, "0")}`;
}

/** The CPI-U levels of the last ten years; `coveredThrough` the end of the newest month. */
export async function fetchBlsCpi(
  get: BondFetch,
  today: string,
): Promise<BenchmarkFetchResult> {
  const endYear = Number(today.slice(0, 4));
  const url = blsCpiUrl(endYear - BLS_YEARS + 1, endYear);
  const response = await get(url);
  if (response.status !== 200) {
    throw refuse(`${url} answered HTTP ${response.status}`);
  }
  if (
    response.url !== undefined &&
    new URL(response.url).hostname !== BLS_HOST
  ) {
    throw refuse("the answer came from another host");
  }
  if (response.body.byteLength > MAX_BYTES)
    throw refuse("the answer is too large");
  const observations = parseBlsCpi(
    new TextDecoder("utf-8").decode(response.body),
    today,
  );
  return {
    observations,
    coveredThrough: endOfMonth(
      observations[observations.length - 1].observationDate,
    ),
    sourceUrl: url,
  };
}
