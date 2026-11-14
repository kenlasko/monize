import type { ValidatedToken } from "../pat.service";

/**
 * The one reading of "this request presents a personal access token".
 *
 * Three places ask it and must agree: `PatAccessGuard` (which decides whether
 * the token may reach the route), `JwtStrategy` (which turns it into
 * `req.user`) and `CsrfGuard` (which skips the double-submit check for it). A
 * second spelling in any of them -- a different case rule, a cookie fallback --
 * would let a request be exempted from CSRF by one reader and authenticated by
 * a cookie in another.
 */
const PAT_BEARER = /^Bearer (pat_\S+)$/i;

interface HeaderCarrier {
  headers?: { authorization?: unknown };
}

/** The raw `pat_...` token of an `Authorization: Bearer` header, else null. */
export function patBearerOf(req: HeaderCarrier): string | null {
  const header = req.headers?.authorization;
  if (typeof header !== "string") return null;
  return PAT_BEARER.exec(header)?.[1] ?? null;
}

/**
 * What `PatAccessGuard` admitted, keyed by the request object itself.
 *
 * A WeakMap rather than a property on the request: nothing a client sends and
 * no other middleware can populate it, so "an entry exists" means exactly "the
 * guard validated this token AND admitted it to this route". `JwtStrategy`
 * authenticates a PAT only from an entry, which is what makes the route policy
 * impossible to bypass.
 */
const admitted = new WeakMap<object, ValidatedToken>();

export function admitPat(req: object, token: ValidatedToken): void {
  admitted.set(req, token);
}

export function admittedPatOf(req: object): ValidatedToken | undefined {
  return admitted.get(req);
}
