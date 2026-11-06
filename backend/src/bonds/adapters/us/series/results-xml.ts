import { SeriesFetchError } from "../../../bond-adapter";

/**
 * The results file of one auction (`Auction_v7_0_0.xsd`): an announcement and
 * its results, each a flat list of elements. Read with a fixed element name per
 * lookup: no entity is expanded, no DTD is accepted, nothing is evaluated.
 */
export interface ResultsXml {
  /** The element's text: "" when it is empty, undefined when it is absent. */
  announcement(name: string): string | undefined;
  results(name: string): string | undefined;
}

/**
 * The text between a section's opening and its first closing tag, found by
 * `indexOf`: a lazy pattern over a body of repeated opening tags is quadratic
 * (840 KB took seconds). A section is unique in a results file, so a second
 * opening tag is a changed format, refused before any closing tag is searched.
 */
function sectionOf(xml: string, tag: string): string {
  const open = `<${tag}>`;
  const start = xml.indexOf(open);
  if (start < 0 || xml.indexOf(open, start + open.length) >= 0) {
    throw new SeriesFetchError("SOURCE_FORMAT_CHANGED", { field: tag });
  }
  const from = start + open.length;
  const end = xml.indexOf(`</${tag}>`, from);
  if (end < 0) {
    throw new SeriesFetchError("SOURCE_FORMAT_CHANGED", { field: tag });
  }
  return xml.slice(from, end);
}

function elementOf(section: string, name: string): string | undefined {
  if (!/^[A-Za-z0-9]+$/.test(name)) {
    throw new RangeError(`Not an element name: ${name}`);
  }
  const full = new RegExp(`<${name}>([^<]*)</${name}>`).exec(section);
  if (full) return full[1].trim();
  return new RegExp(`<${name}\\s*/>`).test(section) ? "" : undefined;
}

export function parseResultsXml(body: Uint8Array): ResultsXml {
  const xml = new TextDecoder("utf-8").decode(body);
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new SeriesFetchError("SOURCE_FORMAT_CHANGED", { field: "xml" });
  }
  const announcement = sectionOf(xml, "AuctionAnnouncement");
  const results = sectionOf(xml, "AuctionResults");
  return {
    announcement: (name) => elementOf(announcement, name),
    results: (name) => elementOf(results, name),
  };
}
