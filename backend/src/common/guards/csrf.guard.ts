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

@Injectable()
export class CsrfGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private configService: ConfigService,
  ) {}

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

    // H8: Verify HMAC binding to session if token includes signature
    const sessionId = request.user?.id;
    const jwtSecret = this.configService.get<string>("JWT_SECRET");
    if (sessionId && jwtSecret && headerToken.includes(":")) {
      if (!verifyCsrfToken(headerToken, sessionId, jwtSecret)) {
        throw new ForbiddenException("Invalid CSRF token");
      }
    }

    return true;
  }
}
