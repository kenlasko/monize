import {
  BondFetch,
  SeriesFetchError,
  sourceUnavailable as unavailable,
} from "../../../bond-adapter";
import { ParsedSeriesCode, PolishProduct, PRODUCT_SLUGS } from "./series-code";

/** The issuer's own site: the only host the series fetch talks to. */
export const SERIES_HOST = "www.obligacjeskarbowe.pl";
/** `source.provider` of a fetched version. */
export const SERIES_PROVIDER = "obligacjeskarbowe.pl";

export const FETCH_TIMEOUT_MS = 30_000;
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const MAX_PDF_BYTES = 5 * 1024 * 1024;

/**
 * The product's page on the issuer's site; it redirects to the series on sale
 * now, so it describes the product as currently offered.
 */
export function productPageUrl(product: PolishProduct): string {
  return `https://${SERIES_HOST}/oferta-obligacji/${PRODUCT_SLUGS[product]}/`;
}

export function seriesPageUrl(code: ParsedSeriesCode): string {
  return `https://${SERIES_HOST}/oferta-obligacji/${PRODUCT_SLUGS[code.product]}/${code.code.toLowerCase()}/`;
}

function isOwnHttps(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    url.hostname === SERIES_HOST &&
    url.port === "" &&
    url.username === "" &&
    url.password === ""
  );
}

/**
 * The letter's address from the page's link: absolute https on the issuer's host,
 * a path under `/media_files/` ending in `.pdf`. Anything else is not a letter
 * of this issuer and is never fetched.
 */
export function resolveLetterUrl(href: string, pageUrl: string): string {
  const refuse = () =>
    new SeriesFetchError("SOURCE_FORMAT_CHANGED", { field: "letterLink" });
  let url: URL;
  try {
    url = new URL(href, pageUrl);
  } catch {
    throw refuse();
  }
  if (
    !isOwnHttps(url) ||
    !url.pathname.startsWith("/media_files/") ||
    !url.pathname.toLowerCase().endsWith(".pdf")
  ) {
    throw refuse();
  }
  return url.toString();
}

/**
 * One GET on the issuer's host: a request to another host is never made, a
 * redirect elsewhere, a status other than 200, a timeout and an oversized body
 * are refused. `notFound` says what the document is: the series page (404 is
 * `SERIES_NOT_PUBLISHED`, another permanent 4xx `SOURCE_DOCUMENT_MISSING`), the
 * series' letter (any permanent 4xx is `SOURCE_DOCUMENT_MISSING`), or a page
 * that belongs to no one series (`SOURCE_UNAVAILABLE`: every non-200 is
 * transient). 5xx and 429 are always `SOURCE_UNAVAILABLE`.
 */
export async function getFromIssuer(
  get: BondFetch,
  url: string,
  maxBytes: number,
  notFound:
    "SERIES_NOT_PUBLISHED" | "SOURCE_DOCUMENT_MISSING" | "SOURCE_UNAVAILABLE",
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
  if (response.status === 404 && notFound === "SERIES_NOT_PUBLISHED") {
    throw new SeriesFetchError("SERIES_NOT_PUBLISHED");
  }
  if (response.status !== 200) {
    // A permanent 4xx on one series' own document is a refusal of that series
    // (the pass goes on); 5xx, 429 and anything else unexpected stay transient.
    const permanent =
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 429;
    if (permanent && notFound !== "SOURCE_UNAVAILABLE") {
      throw new SeriesFetchError("SOURCE_DOCUMENT_MISSING", {
        document: notFound === "SERIES_NOT_PUBLISHED" ? "page" : "letter",
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
