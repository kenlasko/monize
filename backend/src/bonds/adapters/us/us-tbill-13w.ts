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
  optionalText,
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
/**
 * A 13-week bill is 91 days from issue to maturity; the 8-week bill is 56 and
 * the 17-week 119, so this range is unambiguous (`docs/specs/us-treasury-securities.md`
 * section 9a). The days decide, never the text of `securityTerm` or
 * `originalSecurityTerm`: a 13-week reopening of a 26-week CUSIP may carry
 * either term.
 */
const MIN_DAYS = 85;
const MAX_DAYS = 97;
/** A regular bill; a cash management bill ("CMB") of the same length is not the 13-week bill auction. */
const BILL_TYPE = "BILL";
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
 * One observation per 13-week auction, dated the auction date. A record is a
 * 13-week auction when it is a regular bill (not a cash management bill) of 85
 * to 97 days from issue to maturity. An auction without a rate is skipped (not
 * yet auctioned), never read as zero; a rate of 0.000 is a rate and is kept;
 * two different rates for one auction date are refused.
 */
export function parseTbill13w(body: Uint8Array): BenchmarkObservation[] {
  const byDate = new Map<string, BenchmarkObservation>();
  for (const record of parseAuctionArray(body)) {
    if (optionalText(record, "securityType").toUpperCase() !== BILL_TYPE)
      continue;
    if (optionalText(record, "highDiscountRate") === "") continue;
    const auctionDate = requiredDate(record, "auctionDate");
    const issueDate = requiredDate(record, "issueDate");
    const maturityDate = requiredDate(record, "maturityDate");
    const days = daysBetween(issueDate, maturityDate);
    if (days < MIN_DAYS || days > MAX_DAYS) continue;
    if (auctionDate > issueDate) {
      throw refuse(`the auction of ${auctionDate} is after its issue`);
    }
    const discount = parsePercent(
      requiredText(record, "highDiscountRate"),
      "highDiscountRate",
    );
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
