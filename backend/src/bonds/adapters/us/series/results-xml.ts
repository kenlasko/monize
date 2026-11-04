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

function sectionOf(xml: string, tag: string): string {
  const found = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  if (!found) {
    throw new SeriesFetchError("SOURCE_FORMAT_CHANGED", { field: tag });
  }
  return found[1];
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
