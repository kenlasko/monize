import { ExtractJwt, Strategy } from "passport-jwt";
import { PassportStrategy } from "@nestjs/passport";
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";
import { AuthService } from "../auth.service";
import { DelegationService } from "../../delegation/delegation.service";
import { withUserContext } from "../../common/db/with-context";
import { tr } from "../../i18n/translate";

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
    // A weak secret undermines all JWT signature verification.
    if (!jwtSecret || jwtSecret.length < 32) {
      throw new Error(
        "JWT_SECRET environment variable must be at least 32 characters. " +
          "Generate one with: openssl rand -base64 32",
      );
    }

    super({
      jwtFromRequest: extractJwtFromRequest,
      ignoreExpiration: false,
      secretOrKey: jwtSecret,
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
      await this.delegationService.validateActingContext({
        delegateUserId: payload.sub,
        actingAsUserId: payload.actingAsUserId,
        delegationId: payload.delegationId,
      });

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
