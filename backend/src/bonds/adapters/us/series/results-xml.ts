import { SeriesFetchError } from "../../../bond-adapter";

/**
 * The results file of one auction: an announcement and its results, each looked
 * up by its `Auction_v7_0_0.xsd` element name. Read with a fixed element name
 * per lookup: no entity is expanded, no DTD is accepted, nothing is evaluated.
 * Two layouts are read: `Auction_v7_0_0.xsd`, two flat sections, and
 * `DFS-TreasuryAuctionResults-v20260415`, which TreasuryDirect has published
 * since the auctions of 2026-10-19: one `TreasuryAuctionResults` of nested
 * groups, some elements renamed.
 */
export interface ResultsXml {
  /** The element's text: "" when it is empty, undefined when it is absent. */
  announcement(name: string): string | undefined;
  results(name: string): string | undefined;
}

/** Where the DFS layout states an element: its group, its own name, its `index`. */
type DfsPlace = readonly [group: string, element: string, index?: number];

/** The v7 announcement's elements the cross-check reads, as the DFS layout places them. */
const DFS_ANNOUNCEMENT: ReadonlyMap<string, DfsPlace> = new Map<
  string,
  DfsPlace
>([
  ["CUSIP", ["OfferingDescription", "CUSIP"]],
  ["SecurityType", ["OfferingDescription", "SecurityType"]],
  ["InflationIndexSecurity", ["OfferingDescription", "InflationProtected"]],
  ["FloatingRate", ["OfferingDescription", "FloatingRate"]],
  ["IssueDate", ["Dates", "IssueDate"]],
  ["MaturityDate", ["Dates", "MaturityDate"]],
  ["DatedDate", ["Dates", "DatedDate"]],
  // The DFS layout lists every coupon date; the first is index 1.
  ["FirstInterestPaymentDate", ["Interest", "InterestPaymentDate", 1]],
  ["InterestRate", ["Interest", "InterestRate"]],
  ["Spread", ["Interest", "Spread"]],
  ["RefCPIDatedDate", ["IndexInformation", "ReferenceCPIOnOriginalDatedDate"]],
]);

/** The v7 results' elements the cross-check reads, as the DFS layout places them. */
const DFS_RESULTS: ReadonlyMap<string, DfsPlace> = new Map<string, DfsPlace>([
  ["HighPrice", ["Price", "HighPrice"]],
]);

/**
 * A name read from a second place when the first leaves it out: a TIPS' DFS
 * file states no `HighPrice`, only `AdjustedPrice`, the figure its v7 file
 * gave as `HighPrice` (the 2036 TIPS 91282CRE3: both 99.768091).
 */
const DFS_FALLBACKS: ReadonlyMap<string, DfsPlace> = new Map<string, DfsPlace>([
  ["HighPrice", ["Price", "AdjustedPrice"]],
]);

const DFS_GROUPS = [
  "OfferingDescription",
  "Dates",
  "Interest",
  "IndexInformation",
  "Price",
] as const;

function assertElementName(name: string): void {
  if (!/^[A-Za-z0-9]+$/.test(name)) {
    throw new RangeError(`Not an element name: ${name}`);
  }
}

/**
 * The text between a section's opening and its first closing tag, found by
 * `indexOf`: a lazy pattern over a body of repeated opening tags is quadratic
 * (840 KB took seconds). A section is unique in a results file, so a second
 * opening tag is a changed format, refused before any closing tag is searched.
 * An absent section is `undefined`.
 */
function optionalSectionOf(xml: string, tag: string): string | undefined {
  const open = `<${tag}>`;
  const start = xml.indexOf(open);
  if (start < 0) return undefined;
  if (xml.indexOf(open, start + open.length) >= 0) {
    throw new SeriesFetchError("SOURCE_FORMAT_CHANGED", { field: tag });
  }
  const from = start + open.length;
  const end = xml.indexOf(`</${tag}>`, from);
  if (end < 0) {
    throw new SeriesFetchError("SOURCE_FORMAT_CHANGED", { field: tag });
  }
  return xml.slice(from, end);
}

function sectionOf(xml: string, tag: string): string {
  const section = optionalSectionOf(xml, tag);
  if (section === undefined) {
    throw new SeriesFetchError("SOURCE_FORMAT_CHANGED", { field: tag });
  }
  return section;
}

function elementOf(
  section: string,
  name: string,
  index?: number,
): string | undefined {
  assertElementName(name);
  const attributes = index === undefined ? "" : ` index="${index}"`;
  const full = new RegExp(`<${name}${attributes}>([^<]*)</${name}>`).exec(
    section,
  );
  if (full) return full[1].trim();
  return new RegExp(`<${name}${attributes}\\s*/>`).test(section)
    ? ""
    : undefined;
}

function parseV7(xml: string): ResultsXml {
  const announcement = sectionOf(xml, "AuctionAnnouncement");
  const results = sectionOf(xml, "AuctionResults");
  return {
    announcement: (name) => elementOf(announcement, name),
    results: (name) => elementOf(results, name),
  };
}

/**
 * The DFS layout read through the v7 names: a name it does not place is
 * absent, as is an element of a group the file leaves out (a bill has no
 * `Interest`).
 */
function parseDfs(xml: string): ResultsXml {
  const body = sectionOf(sectionOf(xml, "Data"), "TreasuryAuctionResults");
  const groups = new Map<string, string | undefined>(
    DFS_GROUPS.map((group) => [group, optionalSectionOf(body, group)]),
  );
  const read = (place: DfsPlace | undefined): string | undefined => {
    if (place === undefined) return undefined;
    const [group, element, index] = place;
    const section = groups.get(group);
    return section === undefined
      ? undefined
      : elementOf(section, element, index);
  };
  const lookup =
    (places: ReadonlyMap<string, DfsPlace>) =>
    (name: string): string | undefined => {
      assertElementName(name);
      if (!places.has(name)) return undefined;
      return read(places.get(name)) ?? read(DFS_FALLBACKS.get(name));
    };
  return {
    announcement: lookup(DFS_ANNOUNCEMENT),
    results: lookup(DFS_RESULTS),
  };
}

export function parseResultsXml(body: Uint8Array): ResultsXml {
  const xml = new TextDecoder("utf-8").decode(body);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new SeriesFetchError("SOURCE_FORMAT_CHANGED", { field: "xml" });
  }
  const v7 = xml.includes("<AuctionAnnouncement>");
  const dfs = xml.includes("<TreasuryAuctionResults>");
  // A file in both layouts says nothing certain in either.
  if (v7 && dfs) {
    throw new SeriesFetchError("SOURCE_FORMAT_CHANGED", { field: "xml" });
  }
  return dfs ? parseDfs(xml) : parseV7(xml);
}
