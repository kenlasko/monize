import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { createLogger } from "@/lib/logger";
import { SHARE_PAGE_PATH, SHARE_TARGET_PATH } from "@/lib/share-target";
import { isPublicPath } from "@/lib/public-paths";
import { LOCALE_COOKIE, LOCALE_HEADER } from "@/i18n/config";
import { PATHNAME_HEADER } from "@/i18n/client-messages";
import {
  backendBaseUrl,
  backendRequestHeaders,
  payloadTooLarge,
  resolveRequestLocale,
  responseFromBackend,
} from "@/lib/backend-forward";
import {
  DEFAULT_PROXY_BODY_LIMIT_BYTES,
  declaresBodyOver,
  readBoundedBody,
} from "@/lib/proxy-body-limit";

const logger = createLogger("Proxy");
let backendConnected = false;

// Security headers that mirror next.config.js. Next's `headers()` config is
// only applied to responses Next renders (via NextResponse.next()); responses
// the middleware returns directly -- the unauthenticated redirect to /login and
// the 502 backend-unavailable fallback -- bypass it, so a scanner hitting the
// site root sees a redirect with no HSTS. Applying the same set here keeps every
// middleware-generated response consistent with the framework-rendered ones.
const STATIC_SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  "Cross-Origin-Resource-Policy": "same-origin",
};

// HTTPS-only headers, gated by DISABLE_HTTPS_HEADERS for plain-HTTP deployments
// (mirrors next.config.js and the backend Helmet config).
const HTTPS_SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
};

function applySecurityHeaders(response: NextResponse): NextResponse {
  for (const [key, value] of Object.entries(STATIC_SECURITY_HEADERS)) {
    response.headers.set(key, value);
  }
  if (process.env.DISABLE_HTTPS_HEADERS !== "true") {
    for (const [key, value] of Object.entries(HTTPS_SECURITY_HEADERS)) {
      response.headers.set(key, value);
    }
  }
  return response;
}

function buildCspHeader(nonce: string): string {
  const isDev = process.env.NODE_ENV !== "production";
  return [
    "default-src 'self'",
    // 'wasm-unsafe-eval' is what lets WebAssembly.instantiate run at all under
    // a nonce policy; without it the document scanner's engine is refused with
    // no visible error. It permits WASM compilation only -- it does NOT bring
    // back eval() for JavaScript, which is why it is separate from the dev-only
    // 'unsafe-eval' beside it.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' 'wasm-unsafe-eval'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}

function nextWithCsp(request: NextRequest): NextResponse {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const csp = buildCspHeader(nonce);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  // Overwritten unconditionally so a client cannot choose the root layout's
  // message scope (src/i18n/client-messages.ts).
  requestHeaders.set(PATHNAME_HEADER, request.nextUrl.pathname);
  if (process.env.DISABLE_HTTPS_HEADERS !== "true") {
    requestHeaders.set("x-https-headers-active", "true");
  }

  const { locale, fromCookie } = resolveRequestLocale(request);
  requestHeaders.set(LOCALE_HEADER, locale);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", csp);
  if (!fromCookie) {
    // Persist the detected locale so subsequent requests are deterministic
    // and the backend (nestjs-i18n CookieResolver) sees the same value. Not
    // HttpOnly: the language pickers rewrite it from the client. Secure on the
    // same condition as the backend's auth cookies.
    response.cookies.set(LOCALE_COOKIE, locale, {
      path: "/",
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 365,
      secure:
        process.env.NODE_ENV === "production" &&
        process.env.DISABLE_HTTPS_HEADERS !== "true",
    });
  }
  return response;
}

// MCP clients configured with the bare origin (https://monize.laskonet.com)
// send their JSON-RPC traffic to "/". The Streamable HTTP transport requires
// clients to send "Accept: application/json, text/event-stream" on POST and
// "Accept: text/event-stream" on GET, and follow-up requests carry an
// Mcp-Session-Id / MCP-Protocol-Version header — none of which a browser
// navigation ever sends, so this cannot intercept normal page loads.
//
// The bearer check is why an unauthenticated probe gets a truthful answer. An
// MCP request carrying only "Authorization: Bearer <bad token>" matched none of
// the other signals, so it fell through to the app shell and was answered with a
// redirect to /login and then a 200 — which a security scan reads as the server
// accepting an invalid token, while the MCP endpoint itself had been refusing it
// with a 401 all along. A request holding a bearer token is addressed to the
// API, and the API's own refusal is what must reach it. This app authenticates
// with cookies and never sends an Authorization header, so no page load matches.
// Mcp-Method / Mcp-Name are the routing headers the 2026-07-28 revision requires
// on every Streamable HTTP POST.
function isRootMcpRequest(request: NextRequest, pathname: string): boolean {
  if (pathname !== "/") return false;
  const accept = request.headers.get("accept") ?? "";
  const authorization = request.headers.get("authorization") ?? "";
  return (
    accept.includes("text/event-stream") ||
    authorization.toLowerCase().startsWith("bearer ") ||
    request.headers.has("mcp-session-id") ||
    request.headers.has("mcp-protocol-version") ||
    request.headers.has("mcp-method") ||
    request.headers.has("mcp-name")
  );
}

// OAuth 2.1 endpoints exposed at the application root for the MCP remote
// connector flow. These live outside /api because OAuth issuer URLs and the
// RFC 9728 protected-resource metadata path are fixed by the spec; clients
// (Claude Desktop, mcp-remote, etc.) probe them at exact, well-known URLs.
function isOAuthPath(pathname: string): boolean {
  return (
    pathname === "/oauth" ||
    pathname.startsWith("/oauth/") ||
    pathname.startsWith("/oauth-consent/") ||
    pathname === "/.well-known/oauth-protected-resource" ||
    pathname === "/.well-known/oauth-authorization-server" ||
    pathname.startsWith("/.well-known/oauth-authorization-server/") ||
    pathname === "/.well-known/openid-configuration"
  );
}

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Let Next.js API routes handle health checks directly (no proxy)
  if (pathname.startsWith("/api/v1/health/")) {
    return NextResponse.next();
  }

  // A share the service worker did not catch (evicted worker, or a browser that
  // installed the app without registering one). Answered here, first, and
  // without touching the body: the shared files are never uploaded anywhere by
  // this path, and a multipart POST must not be allowed to fall through to the
  // unauthenticated /login redirect, which would replay it. 303 turns it into a
  // GET so the user lands on an ordinary page that explains what happened.
  if (request.method === "POST" && pathname === SHARE_TARGET_PATH) {
    return applySecurityHeaders(
      NextResponse.redirect(
        new URL(`${SHARE_PAGE_PATH}?missed=1`, request.url),
        303,
      ),
    );
  }

  // Handle API proxying to backend
  const rootMcp = isRootMcpRequest(request, pathname);
  if (pathname.startsWith("/api/") || isOAuthPath(pathname) || rootMcp) {
    const apiUrl = backendBaseUrl();
    const backendPath = rootMcp ? "/api/v1/mcp" : pathname;
    const url = new URL(backendPath + request.nextUrl.search, apiUrl);
    logger.debug(`${request.method} ${pathname} -> ${apiUrl}`);

    // X-Forwarded-For replaced with the one vouched-for address, the locale
    // forwarded: `backendRequestHeaders`. Hop-by-hop headers are dropped: the
    // body is buffered below, so undici frames it itself, and it refuses a
    // caller-supplied `transfer-encoding` (sent by an edge that relays an
    // HTTP/3 request of undeclared length) before the request leaves.
    const headers = backendRequestHeaders(request, { stripHopByHop: true });

    // No body this path can legitimately need is larger than the backend's own
    // default limit; the routes that need more are not matched by this proxy
    // at all (`LARGE_UPLOAD_ROUTES`). Refused before it is read when the
    // length is declared, and cut off while reading when it is not.
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    if (
      hasBody &&
      declaresBodyOver(request.headers, DEFAULT_PROXY_BODY_LIMIT_BYTES)
    ) {
      return applySecurityHeaders(payloadTooLarge());
    }

    try {
      // Buffer the body to avoid ReadableStream locking issues in Next.js middleware.
      // Passing request.body (a ReadableStream) directly to undici can intermittently
      // fail with "expected non-null body source" if the stream has already been
      // transferred or locked by the Next.js runtime before the proxy reads it.
      const body = hasBody
        ? await readBoundedBody(request.body, DEFAULT_PROXY_BODY_LIMIT_BYTES)
        : undefined;
      if (body === null) {
        return applySecurityHeaders(payloadTooLarge());
      }

      const response = await fetch(url.toString(), {
        method: request.method,
        headers,
        body,
        redirect: "manual",
      });

      if (!backendConnected) {
        backendConnected = true;
        logger.info(`Backend connected at ${apiUrl}`);
      }

      return responseFromBackend(response);
    } catch (error) {
      logger.error("API proxy error:", error);
      return applySecurityHeaders(
        NextResponse.json({ error: "Backend unavailable" }, { status: 502 }),
      );
    }
  }

  // Handle auth redirects for non-API routes
  // Check for either access token or refresh token (access token expires in 15m,
  // but refresh token lasts 7 days — if present, the frontend will refresh transparently)
  const token =
    request.cookies.get("auth_token")?.value ||
    request.cookies.get("refresh_token")?.value;

  // Allow public paths - don't redirect auth pages to dashboard based on cookie alone,
  // as the cookie may reference a deleted/inactive user. Let the client handle redirects.
  if (isPublicPath(pathname)) {
    return nextWithCsp(request);
  }

  // Protect all other routes
  if (!token) {
    const loginUrl = new URL("/login", request.url);
    // A share can arrive while signed out -- the OS does not know or care. The
    // files are already stashed on the device, so the sign-in carries the way
    // back to them rather than dropping the user on the dashboard with an inbox
    // they have no link to. Scoped to the share page: no other route's redirect
    // changes here. `safeReturnTo` on the login page re-validates this.
    if (pathname === SHARE_PAGE_PATH) {
      loginUrl.searchParams.set(
        "returnTo",
        `${pathname}${request.nextUrl.search}`,
      );
    }
    return applySecurityHeaders(NextResponse.redirect(loginUrl));
  }

  return nextWithCsp(request);
}

export const config = {
  matcher: [
    // Match API routes for proxying -- except the large uploads, which have
    // streaming route handlers of their own. Next copies the body of every
    // request matched here into memory before the proxy runs, so a path left
    // in this list is a path whose body the frontend buffers. Must stay in
    // step with LARGE_UPLOAD_ROUTES (`src/lib/proxy-body-limit.ts`); the
    // catch-all below repeats the exclusion. `proxy-matcher.test.ts` checks both.
    "/api/((?!v1/(?:import/mny/parse|backup/restore|ai/query(?:/stream)?|transactions/[^/]+/attachments|shared-expenses/groups/[^/]+/(?:entries/[^/]+/)?attachments|email-receipts/mailbox/import)/?$).*)",
    // Match OAuth endpoints for proxying. These have to be enumerated
    // explicitly because the catch-all matcher below excludes any path
    // containing a dot (intended for static files), which would otherwise
    // skip the well-known metadata routes.
    "/oauth/:path*",
    "/oauth-consent/:path*",
    "/.well-known/oauth-protected-resource",
    "/.well-known/oauth-authorization-server",
    "/.well-known/oauth-authorization-server/:path*",
    "/.well-known/openid-configuration",
    // Match all other paths except static files
    "/((?!_next/static|_next/image|favicon.ico|.*\\..*|public|api/v1/(?:import/mny/parse|backup/restore|ai/query(?:/stream)?|transactions/[^/]+/attachments|shared-expenses/groups/[^/]+/(?:entries/[^/]+/)?attachments|email-receipts/mailbox/import)/?$).*)",
  ],
};
