/**
 * Where the main window may go (`docs/frontend/shell-contract.md`, "External
 * links stay ordinary anchors"). The app's own origin navigates in the
 * window; a web or mail link to anywhere else goes to the system browser;
 * every other scheme is refused, because a page loaded in the window runs with
 * the shell's preload and a `file:` or `javascript:` URL is not a link a
 * person meant to follow.
 */

export type NavigationDecision =
  | { readonly action: "allow" }
  | { readonly action: "external"; readonly url: string }
  | { readonly action: "deny"; readonly reason: string };

const EXTERNAL_PROTOCOLS: ReadonlySet<string> = new Set([
  "http:",
  "https:",
  "mailto:",
]);
const WEB_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:"]);

/** Longer than any link the app renders; a URL past it is refused unread. */
export const MAX_URL_LENGTH = 8192;

function parse(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

export function decideNavigation(
  raw: string,
  appOrigin: string,
): NavigationDecision {
  if (typeof raw !== "string" || raw.length > MAX_URL_LENGTH) {
    return { action: "deny", reason: "not a usable URL" };
  }
  const url = parse(raw);
  if (url === null) {
    return { action: "deny", reason: "not a URL" };
  }
  if (url.username !== "" || url.password !== "") {
    return { action: "deny", reason: "carries credentials" };
  }
  if (WEB_PROTOCOLS.has(url.protocol) && url.origin === appOrigin) {
    return { action: "allow" };
  }
  if (EXTERNAL_PROTOCOLS.has(url.protocol)) {
    return { action: "external", url: url.href };
  }
  return { action: "deny", reason: `scheme ${url.protocol} is not allowed` };
}

/**
 * The permissions the page is granted, and only on its own origin. The page
 * copies values to the clipboard (`navigator.clipboard.writeText`: recovery
 * codes, API tokens, the MCP address); nothing else it does needs one.
 * Notifications stay denied: the window has no push service (plan D10), and
 * the native ones are raised by the main process from what the page publishes
 * through the notification bridge (`notification-bridge.ts`), never by the
 * page's own Notification API.
 */
export const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-sanitized-write",
]);

export function isPermissionAllowed(
  permission: string,
  requestingUrl: string,
  appOrigin: string,
): boolean {
  if (!ALLOWED_PERMISSIONS.has(permission)) {
    return false;
  }
  const url = parse(requestingUrl);
  return (
    url !== null && WEB_PROTOCOLS.has(url.protocol) && url.origin === appOrigin
  );
}
