import { CatalogEntry, SeriesFetchError } from "../../../bond-adapter";
import { BondTermsError, parseBondTerms } from "../../../domain/bond-terms";
import { ExactDecimal } from "../../../domain/exact-decimal";
import { assertNever } from "../../../domain/assert-never";
import { Auction, AnyCouponAuction, isMonthEnd } from "./auction";
import { SERIES_PROVIDER } from "./series-source";
import {
  fillBill,
  CouponValues,
  fillCoupon,
  SERIES_TEMPLATES,
  SourceDocument,
} from "./templates";

const RATE_PLACES = 12;
const PRICE_PLACES = 9;

/** A percent as the fraction the terms store: "4.285000" -> "0.04285". */
function fractionOf(percent: ExactDecimal): string {
  return percent.div(ExactDecimal.fromInt(100)).toTrimmedString(RATE_PLACES, 1);
}

/** The per-series rate fields of a coupon security: its coupon, its spread, its base CPI. */
function rateValues(
  auction: AnyCouponAuction,
): Pick<CouponValues, "annualRate" | "spread" | "baseReference"> {
  switch (auction.program) {
    case "FRN":
      return { spread: fractionOf(auction.spread) };
    case "TIPS":
      return {
        annualRate: fractionOf(auction.interestRate),
        baseReference: auction.refCpi.toTrimmedString(9, 1),
      };
    case "NOTE":
    case "BOND":
      return { annualRate: fractionOf(auction.interestRate) };
    default:
      return assertNever(auction);
  }
}

/**
 * The catalog entry of an auction from its program's template, through the
 * strict terms parser: version 1, published on the auction date. A document the
 * parser refuses is `SOURCE_FORMAT_CHANGED`: nothing is returned that the
 * engine could not read.
 */
export function buildSeriesEntry(
  seriesCode: string,
  auction: Auction,
  url: string,
): CatalogEntry {
  const source: SourceDocument = {
    provider: SERIES_PROVIDER,
    url,
    document: `auction ${auction.auctionDate}`,
  };
  const template = SERIES_TEMPLATES[auction.program];
  const terms =
    auction.program === "BILL"
      ? fillBill(template, {
          seriesCode,
          issueDate: auction.issueDate,
          maturityDate: auction.maturityDate,
          issuePrice: ExactDecimal.parse(auction.highPrice).toTrimmedString(
            PRICE_PLACES,
            2,
          ),
          source,
        })
      : fillCoupon(template, {
          seriesCode,
          datedDate: auction.datedDate,
          firstCouponDate: auction.firstCouponDate,
          maturityDate: auction.maturityDate,
          endOfMonth: isMonthEnd(auction.maturityDate),
          ...rateValues(auction),
          source,
        });
  try {
    parseBondTerms(terms);
  } catch (error) {
    if (error instanceof BondTermsError) {
      throw new SeriesFetchError(
        "SOURCE_FORMAT_CHANGED",
        { field: "terms" },
        { cause: error },
      );
    }
    throw error;
  }
  return { termsVersion: 1, publishedAt: auction.auctionDate, terms };
}
