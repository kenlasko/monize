/**
 * `monize://` links (`docs/frontend/shell-contract.md`, "Deep links").
 *
 * The scheme is reachable from any program and any web page, so a link is
 * input nobody typed. The only route is `monize://open/<path>`, mapped onto the
 * same path of the app's own origin; everything else is refused. The checks
 * run on the raw text before the URL parser sees it, because the parser
 * forgives things (tabs and newlines dropped, `..` resolved, backslashes kept
 * in a non-special scheme) that would otherwise let a crafted link mean
 * something other than what it looks like.
 */

export const DEEP_LINK_SCHEME = "monize";
const PREFIX = `${DEEP_LINK_SCHEME}://`;
const OPEN_HOST = "open";
export const MAX_DEEP_LINK_LENGTH = 2048;

/** Printable ASCII only: no whitespace, no controls, nothing the parser strips. */
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
/** An encoded slash, backslash, dot or percent hides a path segment. */
const ENCODED_SEPARATOR = /%(2f|5c|2e|25)/i;

/**
 * The URL to load for a deep link, on `appOrigin`, or null to refuse it.
 * Keeps the path, the query and the fragment; never the host or credentials.
 */
export function parseDeepLink(raw: unknown, appOrigin: string): string | null {
  if (typeof raw !== "string" || raw.length > MAX_DEEP_LINK_LENGTH) {
    return null;
  }
  if (!PRINTABLE_ASCII.test(raw) || raw.includes("\\")) {
    return null;
  }
  if (!raw.toLowerCase().startsWith(PREFIX)) {
    return null;
  }
  const rest = raw.slice(PREFIX.length);
  const hostEnd = rest.search(/[/?#]/);
  const host = hostEnd === -1 ? rest : rest.slice(0, hostEnd);
  if (host.toLowerCase() !== OPEN_HOST) {
    // Also refuses `user@open`, `open:443` and an empty host.
    return null;
  }
  const tail = hostEnd === -1 ? "" : rest.slice(hostEnd);
  const target = tail.startsWith("/") ? tail : `/${tail}`;
  const pathEnd = target.search(/[?#]/);
  const path = pathEnd === -1 ? target : target.slice(0, pathEnd);
  if (path.startsWith("//") || ENCODED_SEPARATOR.test(path)) {
    return null;
  }
  if (path.split("/").some((segment) => segment === "." || segment === "..")) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(target, appOrigin);
  } catch {
    return null;
  }
  if (url.origin !== appOrigin || url.username !== "" || url.password !== "") {
    return null;
  }
  return url.href;
}

/**
 * The first argument that looks like a deep link. Windows hands the URL to a
 * new process as a command-line argument; where it sits among Chromium's own
 * switches is not fixed, so the whole list is searched.
 */
export function findDeepLinkArgument(
  argv: readonly string[],
): string | undefined {
  return argv.find(
    (arg) =>
      typeof arg === "string" &&
      arg.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}:`),
  );
}
