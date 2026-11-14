import { ExtractJwt, Strategy } from "passport-jwt";
import { PassportStrategy } from "@nestjs/passport";
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";
import { AuthService } from "../auth.service";
import { DelegationService } from "../../delegation/delegation.service";
import {
  withDelegateContext,
  withUserContext,
} from "../../common/db/with-context";
import { tr } from "../../i18n/translate";
import { isAccessTokenPayload } from "../access-token";
import { jwtSecretFatalProblem } from "../../common/jwt-secret-policy";
import { admittedPatOf, patBearerOf } from "../pat-access/pat-bearer";
import type { ValidatedToken } from "../pat.service";

/**
 * Extract JWT from request - tries Authorization header first, then auth_token cookie
 */
const extractJwtFromRequest = (req: Request): string | null => {
  // Try Authorization header first (Bearer token)
  const authHeader = ExtractJwt.fromAuthHeaderAsBearerToken()(req);
  if (authHeader) {
    return authHeader;
  }

  // Fall back to httpOnly cookie
  if (req.cookies && req.cookies["auth_token"]) {
    return req.cookies["auth_token"];
  }

  return null;
};

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private configService: ConfigService,
    private authService: AuthService,
    private delegationService: DelegationService,
  ) {
    const jwtSecret = configService.get<string>("JWT_SECRET");

    // SECURITY: Fail startup if JWT_SECRET is missing or too short.
    // `checkClusterBoot` applies the same rule first. A long-enough but weak
    // secret (a published placeholder, a typed pattern) boots and is reported
    // by the boot warning, the admin system alert and the admin banner
    // instead -- see `jwt-secret-policy.ts` for why it is not refused here.
    const problem = jwtSecretFatalProblem(jwtSecret);
    if (problem !== null || !jwtSecret) {
      throw new Error(
        `${problem ?? "JWT_SECRET is not set."} JWT_SECRET environment ` +
          "variable must be at least 32 characters of random data. " +
          "Generate one with: openssl rand -base64 32",
      );
    }

    super({
      jwtFromRequest: extractJwtFromRequest,
      ignoreExpiration: false,
      secretOrKey: jwtSecret,
    });
  }

  /**
   * A personal access token is authenticated here, before passport-jwt looks
   * at the header, so every controller under `AuthGuard("jwt")` accepts one
   * without naming a second strategy.
   *
   * SECURITY: only from the record `PatAccessGuard` left for this request. That
   * guard is where the token was validated AND admitted to this route (opt-in,
   * no step-up, no role, scope), so authenticating from anything else -- a
   * fresh `validateToken` here, say -- would let a PAT reach a route the policy
   * refused. A `pat_` bearer with no record fails, and never falls through to
   * the cookie: `CsrfGuard` exempted this request on the strength of its
   * header, so a cookie must not be what authenticates it.
   */
  authenticate(req: Request, options?: unknown): void {
    if (patBearerOf(req) === null) {
      super.authenticate(req, options);
      return;
    }
    const pat = admittedPatOf(req);
    if (!pat) {
      this.fail(401);
      return;
    }
    this.patUser(pat).then(
      (user) => this.success(user),
      (error: Error) => this.error(error),
    );
  }

  /**
   * The `req.user` of a PAT request: the token's owner, acting as themself.
   * A PAT never carries a delegate's acting context, so the shape is the
   * acting-as-self one below. `pat` marks the request as non-interactive --
   * `RequestContextInterceptor` reads it so a script cannot keep the owner's
   * `last_activity_at` (the emergency-access clock) fresh.
   */
  private patUser(pat: ValidatedToken) {
    return withUserContext(pat.userId, async () => {
      const user = await this.authService.getUserStateById(pat.userId);
      if (!user || !user.isActive) {
        throw new UnauthorizedException(
          tr(
            "errors.auth.userNotFoundOrInactive",
            "User not found or inactive",
          ),
        );
      }
      return {
        ...user,
        realUserId: user.id,
        isActing: false,
        delegationId: null,
        pat: { tokenId: pat.tokenId, scopes: pat.scopes },
      };
    });
  }

  async validate(payload: any) {
    // SECURITY: Reject 2FA pending tokens — they should only be used at /auth/2fa/verify
    if (payload.type === "2fa_pending") {
      throw new UnauthorizedException(
        tr(
          "errors.auth.twoFactorVerificationRequired",
          "2FA verification required",
        ),
      );
    }
    // SECURITY: an allowlist, not a deny-list. Every token type shares
    // JWT_SECRET, so anything that is not an access token (a step-up token,
    // an OIDC re-auth marker or artifact) is refused here (`access-token.ts`).
    if (!isAccessTokenPayload(payload)) {
      throw new UnauthorizedException(
        tr("errors.auth.invalidTokenType", "Invalid token type"),
      );
    }
    // mustChangePassword is intentionally NOT enforced here — the global
    // MustChangePasswordGuard handles it, which lets the password-change
    // endpoints themselves remain reachable. The OAuth/PAT bearer paths
    // bypass that guard via @SkipPasswordCheck and enforce it inline instead.
    //
    // RLS: this runs in the guard phase, before the RequestContextInterceptor's
    // scope exists — but it is not identity-less. The verified token's `sub` IS
    // the authenticated user, so seed a *user* context (never a system bypass:
    // jwt validation is the highest-QPS query in the system). Both lookups stay
    // visible without bypass — `getUserStateById` reads the delegate's own
    // `users` row (self-policy), and `validateActingContext` reads
    // `account_delegates` keyed by the delegate id (delegate-side arm), which
    // `withUserContext(payload.sub)` scopes via `app.real_user_id`.
    return withUserContext(payload.sub, async () => {
      const user = await this.authService.getUserStateById(payload.sub);
      if (!user || !user.isActive) {
        throw new UnauthorizedException(
          tr(
            "errors.auth.userNotFoundOrInactive",
            "User not found or inactive",
          ),
        );
      }

      // Acting-as-self / normal user: unchanged shape plus passthrough fields.
      if (!payload.actingAsUserId || !payload.delegationId) {
        return {
          ...user,
          realUserId: user.id,
          isActing: false,
          delegationId: null,
        };
      }

      // Delegate acting as an owner. Re-validate every request (fail closed):
      // revoked/inactive delegation, inactive owner, or an unmet 2FA
      // requirement all reject the token here.
      //
      // RLS: this re-validation reads the OWNER's `users` and `user_preferences`
      // rows (delegateMustEnrollOwn2FA) as well as the delegate's own, so the
      // surrounding `withUserContext(payload.sub)` -- which names only the
      // delegate -- is the wrong identity for half of it. Re-seed both:
      // current = owner, real = delegate, which is what the special policies
      // M2 wrote for delegation expect.
      await withDelegateContext(payload.actingAsUserId, payload.sub, () =>
        this.delegationService.validateActingContext({
          delegateUserId: payload.sub,
          actingAsUserId: payload.actingAsUserId,
          delegationId: payload.delegationId,
        }),
      );

      // SECURITY: `id` becomes the OWNER's id so every existing
      // `where: { userId }` query is correctly scoped to the owner's data.
      // `realUserId` keeps the delegate's id for audit/auth decisions.
      return {
        id: payload.actingAsUserId,
        realUserId: payload.sub,
        isActing: true,
        delegationId: payload.delegationId,
        isActive: true,
        mustChangePassword: user.mustChangePassword,
        role: user.role,
      };
    });
  }
}
