import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { Request } from "express";
import { tr } from "../../i18n/translate";
import { PatService } from "../pat.service";
import { ApiScope, hasApiScope } from "../scopes";
import { REQUIRE_STEP_UP_KEY } from "../step-up/require-step-up.decorator";
import {
  ALLOW_PAT_KEY,
  PAT_IGNORED_KEY,
  PAT_SCOPE_KEY,
  PAT_SELF_AUTHENTICATED_KEY,
} from "../pat-access/pat-access.decorator";
import { admitPat, patBearerOf } from "../pat-access/pat-bearer";
import { ROLES_KEY } from "./roles.guard";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Decides whether a personal access token may reach a REST route.
 *
 * Global, and it only looks at requests whose `Authorization` header carries a
 * `pat_` bearer; cookie and JWT requests pass straight through. For a PAT it
 * is the whole policy, in this order:
 *
 *   1. the route opted in with `@AllowPat()`, and asks for neither a step-up
 *      nor a role -- 403. A step-up or admin route stays session-only even
 *      inside an allowed controller, so annotating a class cannot expose one.
 *      Decided first, from metadata alone, so a closed route costs no lookup;
 *   2. the token is live (`PatService.validateToken`: not revoked, not
 *      expired, owner active and not awaiting a password change) -- 401;
 *   3. the token holds the scope the request needs -- 403.
 *
 * Two kinds of route are not its business and pass untouched: one that
 * validates the bearer itself (`@PatSelfAuthenticated()`, the MCP transport)
 * and one that authenticates nobody (`@PatIgnored()`).
 *
 * Only then is the token recorded for `JwtStrategy` (`admitPat`), which
 * authenticates a PAT from that record and from nothing else. A route this
 * guard did not admit therefore cannot be reached with a PAT even if its own
 * `AuthGuard("jwt")` runs.
 */
@Injectable()
export class PatAccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly patService: PatService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== "http") return true;

    const req = context.switchToHttp().getRequest<Request>();
    const rawToken = patBearerOf(req);
    if (rawToken === null) return true;

    if (
      this.metadata<boolean>(context, PAT_SELF_AUTHENTICATED_KEY) ||
      this.metadata<boolean>(context, PAT_IGNORED_KEY)
    ) {
      return true;
    }

    const allowed = this.metadata<boolean>(context, ALLOW_PAT_KEY) === true;
    const needsStepUp =
      this.metadata<unknown>(context, REQUIRE_STEP_UP_KEY) !== undefined;
    const roles = this.metadata<string[]>(context, ROLES_KEY);
    const needsRole = Array.isArray(roles) && roles.length > 0;
    if (!allowed || needsStepUp || needsRole) {
      throw new ForbiddenException(
        tr(
          "errors.auth.patRouteNotAllowed",
          "This endpoint is not available to personal access tokens. Sign in to use it.",
        ),
      );
    }

    const token = await this.patService.validateToken(rawToken);

    const required =
      this.metadata<ApiScope>(context, PAT_SCOPE_KEY) ??
      (READ_METHODS.has(req.method.toUpperCase()) ? "read" : "write");
    if (!hasApiScope(token.scopes, required)) {
      throw new ForbiddenException(
        tr(
          "errors.auth.patInsufficientScope",
          `This personal access token does not have the "${required}" scope`,
          { scope: required },
        ),
      );
    }

    admitPat(req, token);
    return true;
  }

  private metadata<T>(context: ExecutionContext, key: string): T | undefined {
    return this.reflector.getAllAndOverride<T | undefined>(key, [
      context.getHandler(),
      context.getClass(),
    ]);
  }
}
