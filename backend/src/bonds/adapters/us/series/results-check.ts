import { ExactDecimal } from "../../../domain/exact-decimal";
import { Auction, inconsistent } from "./auction";
import { ResultsXml } from "./results-xml";
import { AuctionRecord, formatChanged, optionalText, parseDate } from "./ta-ws";

const DECIMAL = /^\d{1,6}(?:\.\d{1,9})?$/;

/** A figure of the results file as an exact decimal; anything else is a changed format. */
function decimal(text: string): ExactDecimal {
  if (!DECIMAL.test(text)) throw formatChanged("results");
  return ExactDecimal.parse(text);
}

/** The announcement's element, required: a missing one is a changed format. */
function announced(xml: ResultsXml, name: string): string {
  const value = xml.announcement(name);
  if (value === undefined) throw formatChanged(name);
  return value;
}

/** The results' element, falling back to the announcement's (the rate is stated in both). */
function resulted(xml: ResultsXml, name: string): string {
  return xml.results(name) || xml.announcement(name) || "";
}

function sameDecimal(field: string, json: string, xml: string): void {
  if (json === "" && xml === "") return;
  if (json === "" || xml === "") throw inconsistent(field, json, xml);
  if (decimal(json).cmp(decimal(xml)) !== 0) {
    throw inconsistent(field, json, xml);
  }
}

function same(field: string, json: string, fromXml: string): void {
  if (json !== fromXml) throw inconsistent(field, json, fromXml);
}

/**
 * The JSON's auction against the results file it names (country spec section
 * 3.4): CUSIP, security type, issue, maturity and dated date, coupon and price
 * must agree. A bill's price must be in both; a note's price is compared when
 * both state it.
 */
export function crossCheckResults(
  auction: Auction,
  record: AuctionRecord,
  xml: ResultsXml,
): void {
  same("cusip", auction.cusip, announced(xml, "CUSIP").toUpperCase());
  same(
    "securityType",
    optionalText(record, "securityType").toUpperCase(),
    announced(xml, "SecurityType").toUpperCase(),
  );
  same(
    "issueDate",
    auction.issueDate,
    parseDate(announced(xml, "IssueDate"), "IssueDate"),
  );
  same(
    "maturityDate",
    auction.maturityDate,
    parseDate(announced(xml, "MaturityDate"), "MaturityDate"),
  );
  const xmlPrice = xml.results("HighPrice");
  if (auction.program === "BILL") {
    if (!xmlPrice) throw formatChanged("HighPrice");
    sameDecimal("highPrice", auction.highPrice, xmlPrice);
    return;
  }
  same(
    "datedDate",
    auction.datedDate,
    parseDate(announced(xml, "DatedDate"), "DatedDate"),
  );
  const xmlRate = resulted(xml, "InterestRate");
  if (xmlRate === "") throw formatChanged("InterestRate");
  sameDecimal(
    "interestRate",
    auction.interestRate.toTrimmedString(9, 0),
    xmlRate,
  );
  if (auction.highPrice !== "" && xmlPrice) {
    sameDecimal("highPrice", auction.highPrice, xmlPrice);
  }
}
