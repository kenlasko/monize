/**
 * What a dynamically registered OAuth client may call itself and where it may
 * send an authorization code (GHSA-vmgq-326p-fprx).
 *
 * Registration stays open: MCP clients register themselves, and consent is the
 * control, as it is for every OAuth provider that lets anyone create an app.
 * Consent only works when what the person reads is honest, so registration
 * refuses a name built to read as something else and a redirect that would
 * carry the code in the clear, and every surface that names a client (the
 * consent page, the new-app notice, Settings > Connected apps) cleans a stored
 * name through `displayClientName` -- clients registered before these rules
 * existed are rebuilt on lookup without being validated again.
 *
 * The messages are OAuth `error_description`s, ASCII for the client developer
 * (RFC 7591 section 3.2.2), so they are not translated.
 */

/** Longest client name, in code points, that registration accepts or a surface shows. */
export const CLIENT_NAME_MAX = 100;

// Control (\p{Cc}: line breaks), format (\p{Cf}: bidi overrides U+202A-202E,
// isolates U+2066-2069, marks U+200E/F, zero-width) and line/paragraph
// separator characters (\p{Zl}, \p{Zp}: U+2028/U+2029) can make a name render
// as a different one, or spoof a notice's title, subject and push text.
const UNSAFE_NAME_CHAR = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const UNSAFE_NAME_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+/gu;

/**
 * The hostnames on which a plain `http` redirect stays on the person's own
 * device. The same set oidc-provider uses for native clients.
 */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** At most `max` code points: a UTF-16 slice can split a surrogate pair, and
 * PostgreSQL's jsonb rejects the lone half, which would drop a notice. */
export function boundCodePoints(text: string, max: number): string {
  return Array.from(text).slice(0, max).join("");
}

/**
 * A stored client name as a surface may show it: unsafe characters replaced,
 * trimmed and bounded; `fallback` (the client id) when nothing is left.
 */
export function displayClientName(
  name: string | null | undefined,
  fallback: string,
): string {
  const cleaned =
    typeof name === "string"
      ? boundCodePoints(
          name.replace(UNSAFE_NAME_CHARS, " ").trim(),
          CLIENT_NAME_MAX,
        )
      : "";
  return cleaned || boundCodePoints(fallback, CLIENT_NAME_MAX);
}

/**
 * Whether a name presents itself as Monize. Compatibility-folded and
 * lower-cased with everything but letters and digits removed, so "M o n i z e",
 * "MONIZE-Support" and fullwidth letters all match.
 */
export function claimsToBeMonize(name: string): boolean {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "")
    .includes("monize");
}

/**
 * Why registration refuses this `client_name`, or null when it may be stored.
 * A value that is not a string is left to the provider's own type check.
 */
export function clientNameProblem(name: unknown): string | null {
  if (typeof name !== "string") return null;
  if (UNSAFE_NAME_CHAR.test(name)) {
    return "client_name must not contain control, formatting or separator characters";
  }
  if (name.trim() === "") return "client_name must not be blank";
  if (Array.from(name).length > CLIENT_NAME_MAX) {
    return `client_name must not be longer than ${CLIENT_NAME_MAX} characters`;
  }
  if (claimsToBeMonize(name)) {
    return "client_name must not present the application as Monize";
  }
  return null;
}

/**
 * Why registration refuses this redirect URI, or null when it may be stored.
 *
 * oidc-provider forces `https` only for implicit-flow web clients, so a
 * code-flow web client could register `http://<any host>` and have the code
 * sent in the clear. OAuth 2.1 allows plain `http` only on a loopback address,
 * which is what desktop and CLI clients use. Every other rule (custom schemes
 * for native apps, forbidden schemes, fragments) is the provider's, and a value
 * it cannot parse is left to it.
 */
export function redirectUriProblem(uri: unknown): string | null {
  if (typeof uri !== "string") return null;
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    return "redirect_uris must use https; plain http is allowed only on a loopback address (localhost, 127.0.0.1 or [::1])";
  }
  return null;
}

/** Whether a redirect URI stays on the person's own device. */
export function isLoopbackRedirect(url: URL): boolean {
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    LOOPBACK_HOSTS.has(url.hostname)
  );
}
