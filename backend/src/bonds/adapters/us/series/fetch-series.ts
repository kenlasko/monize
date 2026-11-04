import {
  BondFetch,
  FetchedSeries,
  SeriesFetchError,
  SourceRef,
} from "../../../bond-adapter";
import { parseSeriesCode, ParsedSeriesCode } from "../cusip";
import {
  Auction,
  inconsistent,
  programOfRecord,
  readBill,
  readCoupon,
} from "./auction";
import { crossCheckResults } from "./results-check";
import { parseResultsXml } from "./results-xml";
import { buildSeriesEntry } from "./series-entry";
import {
  auctionSearchUrl,
  getFromTreasury,
  MAX_JSON_BYTES,
  MAX_XML_BYTES,
  resultsXmlUrl,
  SERIES_PROVIDER,
} from "./series-source";
import {
  AuctionRecord,
  parseAuctionArray,
  requiredDate,
  requiredFlag,
  requiredText,
} from "./ta-ws";

function invalidCode(code: ParsedSeriesCode): SeriesFetchError {
  return new SeriesFetchError("SERIES_CODE_INVALID", {
    seriesCode: code.code,
  });
}

/**
 * The auction a code names: the bill issued on the code's date, or a coupon
 * security's original issue (a reopening has the same terms, country spec
 * section 2). A code whose grammar does not fit the product is invalid.
 */
function selectAuction(
  code: ParsedSeriesCode,
  records: readonly AuctionRecord[],
): AuctionRecord {
  for (const record of records) {
    const cusip = requiredText(record, "cusip").toUpperCase();
    if (cusip !== code.cusip) throw inconsistent("cusip", cusip, code.cusip);
  }
  // A bill's CUSIP alone does not say which of its issues is meant.
  if (
    code.issueDate === null &&
    records.some((record) => programOfRecord(record) === "BILL")
  ) {
    throw invalidCode(code);
  }
  const chosen =
    code.issueDate !== null
      ? records.filter(
          (record) => requiredDate(record, "issueDate") === code.issueDate,
        )
      : records.filter((record) => !requiredFlag(record, "reopening"));
  if (chosen.length === 0) throw new SeriesFetchError("SERIES_NOT_PUBLISHED");
  if (chosen.length > 1) {
    throw inconsistent("auction", String(chosen.length), "1");
  }
  return chosen[0];
}

function readAuction(code: ParsedSeriesCode, record: AuctionRecord): Auction {
  const program = programOfRecord(record);
  if (program === "TIPS" || program === "FRN") {
    throw new SeriesFetchError("PRODUCT_NOT_SUPPORTED", {
      seriesCode: code.code,
      product: program,
    });
  }
  // A bill is named with its issue date, a coupon security by its CUSIP alone.
  if ((program === "BILL") !== (code.issueDate !== null)) {
    throw invalidCode(code);
  }
  return program === "BILL"
    ? readBill(record, code.cusip)
    : readCoupon(record, code.cusip, program);
}

/**
 * Reads one security from TreasuryDirect: the auction record of its CUSIP and,
 * when the record names one, the results file of that auction, cross-checked
 * field by field, filled into the program's template and passed through the
 * strict terms parser. Nothing is returned unless every check holds
 * (INV-BOND-006: refuse before writing).
 */
export async function fetchSeries(
  seriesCode: string,
  get: BondFetch,
  now: () => Date = () => new Date(),
): Promise<FetchedSeries> {
  const code = parseSeriesCode(seriesCode);
  const url = auctionSearchUrl(code.cusip);
  const retrievedAt = now().toISOString();
  const body = await getFromTreasury(get, url, MAX_JSON_BYTES, "auction data");
  const records = parseAuctionArray(body);
  if (records.length === 0) throw new SeriesFetchError("SERIES_NOT_PUBLISHED");

  const record = selectAuction(code, records);
  const auction = readAuction(code, record);
  const sources: SourceRef[] = [
    { provider: SERIES_PROVIDER, url, retrievedAt },
  ];
  if (auction.xmlFileName !== "") {
    const xmlUrl = resultsXmlUrl(auction.xmlFileName);
    const xmlRetrievedAt = now().toISOString();
    const xml = parseResultsXml(
      await getFromTreasury(get, xmlUrl, MAX_XML_BYTES, "results"),
    );
    crossCheckResults(auction, record, xml);
    sources.push({
      provider: SERIES_PROVIDER,
      url: xmlUrl,
      retrievedAt: xmlRetrievedAt,
    });
  }
  return { entry: buildSeriesEntry(code.code, auction, url), sources };
}
