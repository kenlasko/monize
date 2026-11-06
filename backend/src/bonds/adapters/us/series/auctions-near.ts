import { AuctionListing, BondFetch } from "../../../bond-adapter";
import { addDays, daysBetween } from "../../../domain/calendar-date";
import { isValidCusip } from "../cusip";
import {
  getFromTreasury,
  MAX_JSON_BYTES,
  TREASURY_HOST,
} from "./series-source";
import {
  AuctionRecord,
  optionalText,
  parseAuctionArray,
  parseDate,
  parsePercent,
  parseSignedPercent,
} from "./ta-ws";
import { UsProgram } from "./templates";

/** The issue dates listed: a month either side of the trade date. */
export const AUCTION_WINDOW_DAYS = 31;
/** The shortest bill the series fetch accepts (country spec section 3.5). */
const BILL_MIN_DAYS = 28;

type SecurityType = "Bill" | "Note" | "Bond";

/** Which `securityType` lists hold a program, and which of their records are it. */
const PROGRAM_SOURCES: Readonly<
  Record<
    UsProgram,
    { types: readonly SecurityType[]; keep: (r: AuctionRecord) => boolean }
  >
> = {
  BILL: { types: ["Bill"], keep: () => true },
  NOTE: {
    types: ["Note"],
    keep: (r) => !flag(r, "inflationProtected") && !flag(r, "floatingRate"),
  },
  BOND: { types: ["Bond"], keep: (r) => !flag(r, "inflationProtected") },
  // A TIPS and an FRN are typed Note or Bond and told by their flag (section 9c).
  TIPS: { types: ["Note", "Bond"], keep: (r) => flag(r, "inflationProtected") },
  FRN: { types: ["Note"], keep: (r) => flag(r, "floatingRate") },
};

/** A `Yes`/`No` flag; anything but `Yes` is no, so one odd record never sinks the list. */
function flag(record: AuctionRecord, field: string): boolean {
  try {
    return optionalText(record, field) === "Yes";
  } catch {
    return false;
  }
}

/** The auctions of one security type issued from `start` to `end`. */
export function auctionsByIssueUrl(
  type: SecurityType,
  start: string,
  end: string,
): string {
  return (
    `https://${TREASURY_HOST}/TA_WS/securities/search?format=json` +
    `&securityType=${type}&dateFieldName=issueDate` +
    `&startDate=${start}&endDate=${end}`
  );
}

/** `YYMMDD` of an issue date, the suffix of a bill's series code (section 2). */
function yymmdd(date: string): string {
  return date.slice(2, 4) + date.slice(5, 7) + date.slice(8, 10);
}

function optionalDecimal(
  record: AuctionRecord,
  field: string,
  signed: boolean,
): string | null {
  const text = optionalText(record, field);
  if (text === "") return null;
  return (signed ? parseSignedPercent : parsePercent)(
    text,
    field,
  ).toTrimmedString(9, 0);
}

/**
 * One record as a listing, or null for one the series fetch would refuse or
 * that names no series: an invalid CUSIP, a bill shorter than 28 days, a
 * record without its dates. A listing is a pointer for a person to choose;
 * the fetch of the chosen code applies every check of section 3.
 */
function toListing(
  record: AuctionRecord,
  program: UsProgram,
): AuctionListing | null {
  try {
    const identifier = optionalText(record, "cusip").toUpperCase();
    if (!isValidCusip(identifier)) return null;
    const issueDate = parseDate(optionalText(record, "issueDate"), "issueDate");
    const maturityDate = parseDate(
      optionalText(record, "maturityDate"),
      "maturityDate",
    );
    const auctionDate = parseDate(
      optionalText(record, "competitiveAuctionCloseDate"),
      "competitiveAuctionCloseDate",
    );
    if (
      program === "BILL" &&
      daysBetween(issueDate, maturityDate) < BILL_MIN_DAYS
    ) {
      return null;
    }
    const pricePer100 = optionalDecimal(record, "highPrice", false);
    const rate =
      program === "BILL"
        ? {
            rateKind: "DISCOUNT" as const,
            ratePercent: optionalDecimal(record, "highRate", false),
          }
        : program === "FRN"
          ? {
              rateKind: "SPREAD" as const,
              ratePercent: optionalDecimal(record, "spread", true),
            }
          : {
              rateKind: "COUPON" as const,
              ratePercent: optionalDecimal(record, "interestRate", false),
            };
    return {
      seriesCode:
        program === "BILL" ? identifier + yymmdd(issueDate) : identifier,
      identifier,
      term: optionalText(record, "securityTerm"),
      auctionDate,
      issueDate,
      maturityDate,
      reopening: flag(record, "reopening"),
      announced: pricePer100 === null,
      pricePer100,
      ...rate,
    };
  } catch {
    return null;
  }
}

/**
 * The auctions of a program with an issue date within `AUCTION_WINDOW_DAYS` of
 * `date`, nearest issue first (an earlier one, then a shorter one, first on a
 * tie), each auction once.
 * One `search` per security type the program is listed under; a source failure
 * is the fetch's own refusal (`getFromTreasury`).
 */
export async function auctionsNear(
  programCode: string,
  date: string,
  get: BondFetch,
): Promise<AuctionListing[]> {
  const source = PROGRAM_SOURCES[programCode as UsProgram];
  if (source === undefined) return [];
  const program = programCode as UsProgram;
  const start = addDays(date, -AUCTION_WINDOW_DAYS);
  const end = addDays(date, AUCTION_WINDOW_DAYS);
  const byKey = new Map<string, AuctionListing>();
  for (const type of source.types) {
    const body = await getFromTreasury(
      get,
      auctionsByIssueUrl(type, start, end),
      MAX_JSON_BYTES,
      "auction list",
    );
    for (const record of parseAuctionArray(body)) {
      if (!source.keep(record)) continue;
      const listing = toListing(record, program);
      if (listing === null) continue;
      byKey.set(`${listing.identifier}|${listing.issueDate}`, listing);
    }
  }
  const distance = (l: AuctionListing) =>
    Math.abs(daysBetween(date, l.issueDate));
  return [...byKey.values()].sort(
    (a, b) =>
      distance(a) - distance(b) ||
      a.issueDate.localeCompare(b.issueDate) ||
      a.maturityDate.localeCompare(b.maturityDate),
  );
}
