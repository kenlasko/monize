import {
  BondFetch,
  SeriesFetchError,
  sourceUnavailable as unavailable,
} from "../../../bond-adapter";

/** The issuer's own site: the only host the series fetch talks to. */
export const TREASURY_HOST = "www.treasurydirect.gov";
/** `source.provider` of a fetched version; also the tracked provider id. */
export const SERIES_PROVIDER = "treasurydirect";

export const FETCH_TIMEOUT_MS = 30_000;
export const MAX_JSON_BYTES = 2 * 1024 * 1024;
export const MAX_XML_BYTES = 1024 * 1024;

const RESULTS_FILE = /^[A-Za-z0-9_-]{1,64}\.xml$/;

/** The auction record(s) of a CUSIP: a JSON array, one object per auction. */
export function auctionSearchUrl(cusip: string): string {
  return `https://${TREASURY_HOST}/TA_WS/securities/search?cusip=${encodeURIComponent(cusip)}&format=json`;
}

/**
 * The results XML of an auction, from the file name the JSON gives. A name that
 * is not a plain `*.xml` file name (a path, a query, another host) is not a
 * results file and is never requested.
 */
export function resultsXmlUrl(fileName: string): string {
  if (!RESULTS_FILE.test(fileName)) {
    throw new SeriesFetchError("SOURCE_FORMAT_CHANGED", {
      field: "xmlFilenameCompetitiveResults",
    });
  }
  return `https://${TREASURY_HOST}/xml/${fileName}`;
}

function isOwnHttps(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    url.hostname === TREASURY_HOST &&
    url.port === "" &&
    url.username === "" &&
    url.password === ""
  );
}

/**
 * One GET on the issuer's host. A request to another host is never made; a
 * redirect elsewhere, a status other than 200, a timeout and an oversized body
 * are refused. A permanent 4xx on the series' own document is a refusal of that
 * series (`SOURCE_DOCUMENT_MISSING`, the pass goes on); 5xx, 429 and anything
 * else unexpected stay transient (`SOURCE_UNAVAILABLE`).
 */
export async function getFromTreasury(
  get: BondFetch,
  url: string,
  maxBytes: number,
  document: "auction data" | "auction list" | "results",
): Promise<Uint8Array> {
  if (!isOwnHttps(new URL(url))) throw unavailable("host");
  let timer: NodeJS.Timeout | undefined;
  let response: Awaited<ReturnType<BondFetch>>;
  try {
    response = await Promise.race([
      get(url),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("series fetch timed out")),
          FETCH_TIMEOUT_MS,
        );
      }),
    ]);
  } catch (error) {
    throw unavailable("network", {}, error);
  } finally {
    clearTimeout(timer);
  }
  if (response.url !== undefined) {
    let landed: URL;
    try {
      landed = new URL(response.url);
    } catch {
      throw unavailable("redirect");
    }
    if (!isOwnHttps(landed)) throw unavailable("redirect");
  }
  if (response.status !== 200) {
    const permanent =
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 429;
    if (permanent) {
      throw new SeriesFetchError("SOURCE_DOCUMENT_MISSING", {
        document,
        status: String(response.status),
      });
    }
    throw unavailable("status", { status: String(response.status) });
  }
  if (response.body.byteLength > maxBytes) {
    throw new SeriesFetchError("SOURCE_FORMAT_CHANGED", { field: "size" });
  }
  return response.body;
}
