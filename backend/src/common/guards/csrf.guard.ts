import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ConfigService } from "@nestjs/config";
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

    // XC-F1: Always verify HMAC session binding when session info is available.
    // Tokens are always generated with HMAC binding (nonce:hmac format),
    // so we unconditionally verify rather than checking for ":" in the token.
    const sessionId = request.user?.id;
    if (sessionId && this.csrfKey) {
      if (!verifyCsrfToken(headerToken, sessionId, this.csrfKey)) {
        throw new ForbiddenException("Invalid CSRF token");
      }
    }

    return true;
  }
}
