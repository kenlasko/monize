import { SetMetadata } from "@nestjs/common";
import type { ApiScope } from "../scopes";

/**
 * Marks a controller (or one handler) as reachable with a personal access
 * token.
 *
 * The default posture is fail-closed, as it is for delegates
 * (`@AllowDelegate()`): `PatAccessGuard` refuses a PAT on any route NOT
 * annotated with `@AllowPat()`, so a new controller is session-only until
 * someone decides otherwise. Cookie and JWT requests are unaffected.
 *
 * Never put it on sign-in, credential, admin, sharing, emergency-access or
 * backup routes: a PAT is a long-lived secret that works without a second
 * factor, and those routes are how an account is taken over or emptied.
 * `pat-access.guard.spec.ts` pins the list.
 */
export const ALLOW_PAT_KEY = "allowPat";
export const AllowPat = () => SetMetadata(ALLOW_PAT_KEY, true);

/** Session-only handler inside an `@AllowPat()` controller. */
export const NoPat = () => SetMetadata(ALLOW_PAT_KEY, false);

/**
 * The scope a PAT needs for this handler, when the HTTP method does not say.
 *
 * Without it a GET, HEAD or OPTIONS needs `read` and every other method needs
 * `write`. Use `@PatScope("read")` only on a POST that computes an answer and
 * writes nothing (a search, a preview); a wrong one hands a read-only token a
 * write.
 */
export const PAT_SCOPE_KEY = "patScope";
export const PatScope = (scope: ApiScope) => SetMetadata(PAT_SCOPE_KEY, scope);

/**
 * The route validates the bearer itself and applies its own scope rules (the
 * MCP transport, which checks scope per tool). `PatAccessGuard` stands aside.
 */
/**
 * The route authenticates nobody (a health probe, OAuth discovery metadata), so
 * a bearer a client attaches to every request is simply not looked at. Without
 * it an MCP client that sends its PAT during discovery would be refused there.
 *
 * Only for a controller with no `AuthGuard` that reads no cookie: the request
 * is still exempt from CSRF on the strength of its header, so nothing behind
 * this decorator may act for a signed-in user.
 */
export const PAT_IGNORED_KEY = "patIgnored";
export const PatIgnored = () => SetMetadata(PAT_IGNORED_KEY, true);

export const PAT_SELF_AUTHENTICATED_KEY = "patSelfAuthenticated";
export const PatSelfAuthenticated = () =>
  SetMetadata(PAT_SELF_AUTHENTICATED_KEY, true);
