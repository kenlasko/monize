import { ExtractJwt, Strategy } from "passport-jwt";
import { PassportStrategy } from "@nestjs/passport";
import { Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Request } from "express";
import { AuthService } from "../auth.service";

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
      throw new UnauthorizedException("2FA verification required");
    }
    const user = await this.authService.getUserById(payload.sub);
    if (!user || !user.isActive) {
      throw new UnauthorizedException("User not found or inactive");
    }
    return user;
  }
}
