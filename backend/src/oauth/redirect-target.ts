import { isLoopbackRedirect } from "./client-identity";

/**
 * What the consent page shows as the destination of an authorization: the
 * origin (scheme, host and a non-default port) of the request's redirect_uri.
 *
 * The host comes from the WHATWG URL parser, so an internationalised domain is
 * shown in its ASCII (punycode) form and cannot pass for a look-alike Latin
 * name. A native-app redirect with a custom scheme has no web origin (`origin`
 * is the string "null"), so it is shown as `scheme://host`, or as the bare
 * scheme when it has no host. Returns null when there is nothing parseable to
 * show; the page then warns instead of naming a destination.
 */
export function describeRedirectTarget(
  redirectUri: string | null | undefined,
): string | null {
  const url = parse(redirectUri);
  if (!url) return null;
  if (url.origin && url.origin !== "null") return url.origin;
  return url.host ? `${url.protocol}//${url.host}` : url.protocol;
}

/** Lower-cased hostname of a URL, or null when it has none or does not parse. */
export function hostOf(value: string | null | undefined): string | null {
  const url = parse(value);
  return url?.hostname ? url.hostname.toLowerCase() : null;
}

function parse(value: string | null | undefined): URL | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

/**
 * Who the consent page says is asking, read from the redirect_uri alone: the
 * one fact about a self-registered client Monize can vouch for (the code goes
 * there), unlike the name, which the registrant chose.
 *
 * - `web`: a website, named by its host (ASCII form, with a non-default port);
 * - `device`: a loopback address, i.e. an application on the person's own
 *   device (desktop and CLI MCP clients);
 * - `app`: a native app's custom scheme, named by that scheme;
 * - null: nothing parseable, and the page warns instead.
 */
export type ConsentRequester =
  | { kind: "web"; host: string }
  | { kind: "device" }
  | { kind: "app"; scheme: string };

export function describeRequester(
  redirectUri: string | null | undefined,
): ConsentRequester | null {
  const url = parse(redirectUri);
  if (!url) return null;
  if (isLoopbackRedirect(url)) return { kind: "device" };
  if (url.protocol === "https:" || url.protocol === "http:") {
    return url.host ? { kind: "web", host: url.host } : null;
  }
  return { kind: "app", scheme: `${url.protocol}//` };
}
