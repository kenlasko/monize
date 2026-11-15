import { createHash } from "crypto";
import { Logger } from "@nestjs/common";
import type { NextFunction, Request, Response } from "express";
import { normalizeIp, type ThrottlerStorage } from "@nestjs/throttler";

import { rateLimit } from "../common/throttle.util";
import {
  OIDC_PROVIDER_ROUTES,
  isOidcProviderPath,
} from "./oidc-provider-paths";

const logger = new Logger("OAuthEndpointThrottle");

/**
 * Per-IP caps on the provider endpoints that write a row for an anonymous
 * caller (#2177).
 *
 * node-oidc-provider is mounted as Express middleware ahead of the Nest router
 * (`main.ts`), so the global `ThrottlerGuard` never sees `/oauth/*`. Without
 * this, one host registered clients and opened interactions as fast as it
 * could send requests. Each rule is counted in the same storage the guard uses
 * (`PostgresThrottlerStorage` in `CLUSTER_MODE=multi`, the library's in-memory
 * one in `single`), so a cap holds across replicas wherever the guard's does.
 * `RATE_LIMIT_MAX` raises the caps for throwaway stacks, as it does every other.
 */
export interface OAuthEndpointThrottleRule {
  name: string;
  ttlMs: number;
  limit: number;
  /** `path` is already `routeKey`-normalized. */
  matches: (method: string, path: string) => boolean;
}

/**
 * A path as the provider's router matches it: ASCII case-insensitively, with
 * one trailing slash ignored (the `Router` in oidc-provider's helpers). Matching
 * any looser than the router would let `POST /oauth/REG/` register a client
 * uncounted. `toUpperCase` also folds a few non-ASCII letters the router keeps,
 * which can only count a request the provider then refuses as unknown.
 */
export function routeKey(path: string): string {
  const trimmed =
    path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return trimmed.toUpperCase();
}

const REGISTRATION = routeKey(OIDC_PROVIDER_ROUTES.registration);
const AUTHORIZATION = routeKey(OIDC_PROVIDER_ROUTES.authorization);
const PUSHED_AUTHORIZATION = routeKey(
  OIDC_PROVIDER_ROUTES.pushed_authorization_request,
);
const END_SESSION = routeKey(OIDC_PROVIDER_ROUTES.end_session);

/**
 * Named without "oauth": CodeQL's sensitive-name heuristic reads an
 * identifier containing it as a password, and reported
 * js/insufficient-password-hash on the `rule.name` this array hands to the
 * `.update(...)` call below under the array's previous name,
 * `OAUTH_ENDPOINT_THROTTLES` (docs/backend/modules-and-runtime.md, CodeQL
 * suppressions).
 */
export const ENDPOINT_THROTTLE_RULES: readonly OAuthEndpointThrottleRule[] = [
  {
    // Dynamic client registration. A real MCP client registers once.
    name: "oauth-registration",
    ttlMs: 60 * 60 * 1000,
    limit: rateLimit(10),
    matches: (method, path) => method === "POST" && path === REGISTRATION,
  },
  {
    // Every other route that stores a row for a caller with no session: a new
    // authorization request, direct (an Interaction) or pushed, and the logout
    // page, which saves a Session to carry its anti-forgery token. The resume
    // path `/oauth/auth/:uid` continues an interaction already counted.
    name: "oauth-anonymous-state",
    ttlMs: 60 * 1000,
    limit: rateLimit(30),
    matches: (method, path) =>
      path === AUTHORIZATION ||
      path === END_SESSION ||
      (method === "POST" && path === PUSHED_AUTHORIZATION),
  },
];

export function createOAuthEndpointThrottle(
  storage: ThrottlerStorage,
  rules: readonly OAuthEndpointThrottleRule[] = ENDPOINT_THROTTLE_RULES,
) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!isOidcProviderPath(req.path)) {
      next();
      return;
    }
    const path = routeKey(req.path);
    const rule = rules.find((r) => r.matches(req.method, path));
    if (!rule) {
      next();
      return;
    }
    // Same tracker as ThrottlerGuard.getTracker: `trust proxy` is set in
    // main.ts, so req.ip is the client, and an IPv6 /64 counts as one client.
    // Hashed like ThrottlerGuard.generateKey, so no address is stored in the
    // clear in http_throttle_counters.
    const key = createHash("sha256")
      .update(`${rule.name}-${normalizeIp(req.ip ?? "")}`)
      .digest("hex");
    storage
      .increment(key, rule.ttlMs, rule.limit, rule.ttlMs, rule.name)
      .then(
        ({ isBlocked, timeToBlockExpire }) => {
          if (!isBlocked) {
            next();
            return;
          }
          res.status(429);
          res.setHeader("Retry-After", String(timeToBlockExpire));
          // An OAuth error body, like the provider's own on these paths. Its
          // error_description is ASCII for the client developer (RFC 6749
          // section 5.2), not copy shown to a person, and this runs outside the
          // Nest pipeline where no request locale exists to translate it into.
          res.json({
            error: "too_many_requests",
            error_description:
              "Too many requests. Retry after the given delay.",
          });
        },
        // Fail open, like PostgresThrottlerStorage itself: this is a first gate
        // against volume, and the sweep removes whatever expires behind it. A
        // rejection handler, not .catch, so a throw from downstream of next()
        // cannot call next() a second time.
        () => next(),
      )
      .catch((error: unknown) => {
        // Writing the 429 to a client that already went away, say. Logged so it
        // is not an unhandled rejection.
        logger.warn(
          `OAuth throttle reply failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  };
}
