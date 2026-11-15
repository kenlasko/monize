import type { CorsOptions } from "@nestjs/common/interfaces/external/cors-options.interface";

type CorsRequest = { path?: string; url?: string };
type CorsCallback = (err: Error | null, options: CorsOptions) => void;

const MCP_HEADERS = [
  "Authorization",
  "Content-Type",
  "Accept",
  // Mcp-Session-Id is 2025-era; Mcp-Method and Mcp-Name are required on
  // every 2026-07-28 Streamable HTTP POST so intermediaries can route
  // and authorize without parsing the JSON-RPC body.
  "Mcp-Session-Id",
  "Mcp-Protocol-Version",
  "Mcp-Method",
  "Mcp-Name",
];

function isMcpPath(path: string): boolean {
  return path === "/api/v1/mcp" || path.startsWith("/api/v1/mcp/");
}

// Discovery and the OAuth provider stay world-readable: a client fetches
// them before it holds any credential. Some of these paths do read a cookie
// (oauth-consent, /oauth/auth); the wildcard is still safe because
// `credentials: false` never sends Access-Control-Allow-Credentials, so a
// browser does not let a foreign page read a response made with cookies.
function isPublicOAuthPath(path: string): boolean {
  return (
    path === "/oauth" ||
    path.startsWith("/oauth/") ||
    path.startsWith("/api/v1/oauth-consent/") ||
    path === "/.well-known/oauth-protected-resource" ||
    path === "/.well-known/oauth-authorization-server" ||
    path.startsWith("/.well-known/oauth-authorization-server/") ||
    path === "/.well-known/openid-configuration"
  );
}

/**
 * Path-aware CORS for `app.enableCors`. The OAuth and discovery surfaces
 * answer any origin. The MCP endpoint answers only the first-party
 * allow-list (kenlasko/monize#2178): its clients are native processes that
 * send no Origin, so a wildcard only let a foreign page read MCP output
 * with a bearer token it had obtained. The rest of the app keeps the
 * strict, credentialed allow-list because it relies on cookies + CSRF.
 */
export function createCorsDelegate(allowedOrigins: readonly string[]) {
  return (req: CorsRequest, callback: CorsCallback): void => {
    const path = req.path ?? req.url ?? "";

    if (isPublicOAuthPath(path) || isMcpPath(path)) {
      callback(null, {
        // An array reflects a listed Origin and omits the header otherwise,
        // so a foreign page's preflight fails in the browser.
        origin: isMcpPath(path) ? [...allowedOrigins] : "*",
        credentials: false,
        methods: ["GET", "POST", "DELETE", "OPTIONS"],
        allowedHeaders: MCP_HEADERS,
        exposedHeaders: ["Mcp-Session-Id", "WWW-Authenticate"],
        maxAge: 600,
      });
      return;
    }

    callback(null, {
      origin: (origin, cb) => {
        // Requests with no Origin header (server-to-server, health checks,
        // curl, same-origin navigations): always allow. Non-browser clients
        // can trivially set any Origin, so blocking null Origin adds no real
        // security. Sandboxed-iframe abuse is prevented by Helmet's
        // frameguard: { action: "deny" } instead.
        if (!origin) return cb(null, true);
        if (allowedOrigins.includes(origin)) cb(null, true);
        else cb(new Error("Not allowed by CORS"));
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "Accept",
        "X-CSRF-Token",
        "X-Restore-Password",
        "X-Restore-OIDC-Token",
        // Sent by the client on an encrypted restore whose backup password
        // differs from the login one. Missing here, that restore died at the
        // preflight -- the same argument as the ticket header below, and a gap
        // that predates it.
        "X-Backup-Password",
        // Without this a cross-origin restore upload never leaves the browser:
        // the preflight refuses the header, so the upload is "blocked by CORS"
        // rather than refused with the 403 that says what to do.
        "X-Restore-Upload-Ticket",
        "Mcp-Session-Id",
      ],
      exposedHeaders: ["Mcp-Session-Id"],
    });
  };
}
