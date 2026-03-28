import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import * as crypto from "crypto";
import { SKIP_CSRF_KEY } from "../decorators/skip-csrf.decorator";
import { verifyCsrfToken } from "../csrf.util";
import { derivePurposeKey } from "../../auth/crypto.util";

@Injectable()
export class CsrfGuard implements CanActivate {
  private readonly csrfKey: string;

  constructor(
    private reflector: Reflector,
    private configService: ConfigService,
    private jwtService: JwtService,
  ) {
    const jwtSecret = this.configService.get<string>("JWT_SECRET");
    this.csrfKey = jwtSecret ? derivePurposeKey(jwtSecret, "csrf-token") : "";
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();

    // Skip safe HTTP methods
    const method = request.method.toUpperCase();
    if (["GET", "HEAD", "OPTIONS"].includes(method)) {
      return true;
    }

    // Skip routes decorated with @SkipCsrf()
    const skipCsrf = this.reflector.getAllAndOverride<boolean>(SKIP_CSRF_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (skipCsrf) {
      return true;
    }

    const cookieToken = request.cookies?.["csrf_token"];
    const headerToken = request.headers?.["x-csrf-token"];

    if (!cookieToken || !headerToken) {
      throw new ForbiddenException("Missing CSRF token");
    }

    // Timing-safe comparison to prevent timing attacks
    try {
      const cookieBuf = Buffer.from(cookieToken, "utf-8");
      const headerBuf = Buffer.from(headerToken, "utf-8");

      if (
        cookieBuf.length !== headerBuf.length ||
        !crypto.timingSafeEqual(cookieBuf, headerBuf)
      ) {
        throw new ForbiddenException("Invalid CSRF token");
      }
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new ForbiddenException("Invalid CSRF token");
    }

    // Verify HMAC session binding by extracting the user ID directly from the
    // JWT token. This guard runs as a global guard before the route-level JWT
    // guard, so request.user is not yet populated. We decode the JWT here to
    // get the session ID for HMAC verification. If the token is missing or
    // invalid, we skip the HMAC check (the JWT guard will reject later).
    if (this.csrfKey) {
      const sessionId = this.extractSessionId(request);
      if (sessionId) {
        if (!verifyCsrfToken(headerToken, sessionId, this.csrfKey)) {
          throw new ForbiddenException("Invalid CSRF token");
        }
      }
    }

    return true;
  }

  private extractSessionId(request: any): string | null {
    // Try auth_token cookie first, then Authorization header
    const token =
      request.cookies?.["auth_token"] ||
      this.extractBearerToken(request.headers?.["authorization"]);

    if (!token) return null;

    try {
      const payload = this.jwtService.decode(token);
      return payload?.sub || null;
    } catch {
      return null;
    }
  }

  private extractBearerToken(header: string | undefined): string | null {
    if (!header?.startsWith("Bearer ")) return null;
    return header.slice(7);
  }
}
