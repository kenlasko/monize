/**
 * The provider's endpoint paths, all under `/oauth/*` (see
 * `OAuthProviderService.initialize`). Written once so the per-IP caps in
 * `oauth-endpoint-throttle.ts` cannot drift from the routes they cap.
 */
export const OIDC_PROVIDER_ROUTES = {
  authorization: "/oauth/auth",
  token: "/oauth/token",
  jwks: "/oauth/jwks",
  registration: "/oauth/reg",
  revocation: "/oauth/token/revocation",
  userinfo: "/oauth/me",
  end_session: "/oauth/session/end",
  pushed_authorization_request: "/oauth/request",
} as const;

/**
 * Decides which request paths are handled by node-oidc-provider.
 *
 * The provider is mounted at the application root (not under `/oauth`) because
 * its issuer is the bare origin, so the discovery documents live at the root
 * well-known URLs. Its actual endpoints are kept under `/oauth/*` via the
 * provider's `routes` map (see `OAuthProviderService.initialize`). This
 * predicate is the routing gate for the root mount in `main.ts`: a request is
 * delegated to the provider only when it targets one of those paths, and every
 * other request falls through to the normal Nest router.
 *
 * Kept in its own module so the routing rule is unit-testable (main.ts is
 * excluded from coverage).
 *
 * NOTE: the frontend proxy (`frontend/src/proxy.ts` -> `isOAuthPath`) must
 * forward the same set of paths to the backend; keep the two lists in sync.
 */
export function isOidcProviderPath(path: string): boolean {
  return (
    // Discovery documents, served by the provider at the root because the
    // issuer has no path component.
    path === "/.well-known/openid-configuration" ||
    path === "/.well-known/oauth-authorization-server" ||
    // All provider endpoints (authorization + resume, token, revocation,
    // registration, jwks, ...) are pinned under /oauth/* by the routes map.
    path === "/oauth" ||
    path.startsWith("/oauth/")
  );
}
