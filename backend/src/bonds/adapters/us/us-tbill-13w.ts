import {
  BenchmarkFetchError,
  BenchmarkFetchResult,
  BenchmarkObservation,
  BondFetch,
  SeriesFetchError,
} from "../../bond-adapter";
import { daysBetween } from "../../domain/calendar-date";
import { ExactDecimal } from "../../domain/exact-decimal";
import { getFromTreasury, TREASURY_HOST } from "./series/series-source";
import {
  parseAuctionArray,
  parsePercent,
  requiredDate,
  requiredText,
} from "./series/ta-ws";

export const TBILL_13W_SOURCE_URL =
  "https://www.treasurydirect.gov/auctions/auction-query/";
/** The 13-week history a floating rate note of two years needs, with a margin. */
export const TBILL_HISTORY_DAYS = 900;
const MAX_BYTES = 5 * 1024 * 1024;
const TERM = "13-Week";
const MIN_DAYS = 84;
const MAX_DAYS = 98;
const DAYS_IN_YEAR = 360;
/** The fraction column holds ten decimals (NUMERIC(20,10)). */
const FRACTION_PLACES = 10;
const PERCENT_PLACES = 9;

export function tbill13wUrl(days: number = TBILL_HISTORY_DAYS): string {
  return `https://${TREASURY_HOST}/TA_WS/securities/auctioned?format=json&type=Bill&days=${days}`;
}

function refuse(reason: string, cause?: unknown): BenchmarkFetchError {
  return new BenchmarkFetchError(`13-week bill: ${reason}`, { cause });
}

/**
 * The money market yield of a bill from its high discount rate: `r = D / (1 - D x t / 360)`
 * with `D` the discount rate and `t` the days from issue to maturity. The
 * percent is rounded to nine decimals; the stored fraction to ten (the column's
 * scale), so the eleventh decimal of the fraction is lost.
 */
export function moneyMarketYield(
  discountPercent: ExactDecimal,
  days: number,
): { readonly percent: string; readonly fraction: string } {
  const hundred = ExactDecimal.fromInt(100);
  const discount = discountPercent.div(hundred);
  const denominator = ExactDecimal.fromInt(1).sub(
    discount
      .mul(ExactDecimal.fromInt(days))
      .div(ExactDecimal.fromInt(DAYS_IN_YEAR)),
  );
  const percent = discountPercent
    .div(denominator)
    .round(PERCENT_PLACES, "HALF_UP");
  return {
    percent: percent.toFixed(PERCENT_PLACES),
    fraction: percent
      .div(hundred)
      .round(FRACTION_PLACES, "HALF_UP")
      .toTrimmedString(FRACTION_PLACES, 4),
  };
}

/**
 * One observation per 13-week auction, dated the auction date. Other terms are
 * skipped; an auction without a rate is skipped (not yet auctioned), never read
 * as zero; two different rates for one auction date are refused.
 */
export function parseTbill13w(body: Uint8Array): BenchmarkObservation[] {
  const byDate = new Map<string, BenchmarkObservation>();
  for (const record of parseAuctionArray(body)) {
    if (requiredText(record, "securityTerm") !== TERM) continue;
    const rateText = record.highDiscountRate;
    if (rateText === undefined || rateText === null || rateText === "")
      continue;
    const auctionDate = requiredDate(record, "auctionDate");
    const issueDate = requiredDate(record, "issueDate");
    const maturityDate = requiredDate(record, "maturityDate");
    const days = daysBetween(issueDate, maturityDate);
    if (days < MIN_DAYS || days > MAX_DAYS || auctionDate > issueDate) {
      throw refuse(`the auction of ${auctionDate} has an unexpected term`);
    }
    const discount = parsePercent(
      requiredText(record, "highDiscountRate"),
      "highDiscountRate",
    );
    if (discount.isZero()) continue;
    const value = moneyMarketYield(discount, days).fraction;
    const known = byDate.get(auctionDate);
    if (known !== undefined) {
      if (known.value !== value) {
        throw refuse(`two different rates for ${auctionDate}`);
      }
      continue;
    }
    byDate.set(auctionDate, {
      observationDate: auctionDate,
      value,
      publishedOn: null,
    });
  }
  if (byDate.size === 0) throw refuse("no 13-week auction with a rate");
  return [...byDate.values()].sort((a, b) =>
    a.observationDate.localeCompare(b.observationDate),
  );
}

/** The 13-week yields of the last auctions; `coveredThrough` the newest auction date. */
export async function fetchTbill13w(
  get: BondFetch,
): Promise<BenchmarkFetchResult> {
  const url = tbill13wUrl();
  let body: Uint8Array;
  try {
    body = await getFromTreasury(get, url, MAX_BYTES, "auction list");
  } catch (error) {
    if (error instanceof SeriesFetchError) throw refuse(error.message, error);
    throw error;
  }
  let observations: BenchmarkObservation[];
  try {
    observations = parseTbill13w(body);
  } catch (error) {
    if (error instanceof SeriesFetchError) throw refuse(error.message, error);
    throw error;
  }
  return {
    observations,
    coveredThrough: observations[observations.length - 1].observationDate,
    sourceUrl: url,
  };
}
