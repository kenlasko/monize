import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { JwtService, TokenExpiredError } from "@nestjs/jwt";
import { REQUIRE_STEP_UP_KEY } from "./require-step-up.decorator";
import type { StepUpPurpose } from "./dto/verify-step-up.dto";

const STEP_UP_HEADER = "x-step-up-token";

interface StepUpPayload {
  sub: string;
  type: string;
  purpose: string;
  jti?: string;
  exp?: number;
}

@Injectable()
export class StepUpGuard implements CanActivate {
  private readonly logger = new Logger(StepUpGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredPurpose = this.reflector.getAllAndOverride<StepUpPurpose>(
      REQUIRE_STEP_UP_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (!requiredPurpose) return true;

    const request = context.switchToHttp().getRequest();
    const user = request.user as { id?: string } | undefined;
    if (!user?.id) {
      // JwtAuthGuard should run before this guard. If we got here without a
      // user the request is malformed; fail closed.
      throw new ForbiddenException({
        code: "STEP_UP_INVALID",
        message: "Step-up token requires an authenticated session",
      });
    }

    const headerValue = request.headers?.[STEP_UP_HEADER];
    const token = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    // CWE-208 (Bearer rule): this is a presence/type check on an
    // attacker-supplied request header, not a comparison against a secret.
    // The branch outcome is fully determined by the caller's own input, so
    // a timing side-channel here reveals nothing the attacker doesn't
    // already know.
    // bearer:disable javascript_lang_observable_timing
    if (!token || typeof token !== "string") {
      throw new ForbiddenException({
        code: "STEP_UP_REQUIRED",
        message: "Step-up verification required",
        purpose: requiredPurpose,
      });
    }

    let payload: StepUpPayload;
    try {
      payload = this.jwtService.verify<StepUpPayload>(token);
    } catch (err) {
      if (err instanceof TokenExpiredError) {
        throw new ForbiddenException({
          code: "STEP_UP_EXPIRED",
          message: "Step-up verification expired",
          purpose: requiredPurpose,
        });
      }
      this.logger.warn(
        `Step-up token rejected: invalid signature for user ${user.id}`,
      );
      throw new ForbiddenException({
        code: "STEP_UP_INVALID",
        message: "Step-up token is invalid",
        purpose: requiredPurpose,
      });
    }

    if (payload.type !== "step_up") {
      this.logger.warn(
        `Step-up token rejected: wrong type '${payload.type}' for user ${user.id}`,
      );
      throw new ForbiddenException({
        code: "STEP_UP_INVALID",
        message: "Step-up token is invalid",
        purpose: requiredPurpose,
      });
    }

    if (payload.purpose !== requiredPurpose) {
      this.logger.warn(
        `Step-up token rejected: purpose '${payload.purpose}' does not match '${requiredPurpose}' for user ${user.id}`,
      );
      throw new ForbiddenException({
        code: "STEP_UP_INVALID",
        message: "Step-up token is scoped to a different action",
        purpose: requiredPurpose,
      });
    }

    if (payload.sub !== user.id) {
      // Bound to the user who verified -- stealing one user's step-up token
      // and swapping JWTs cannot unlock another account.
      this.logger.warn(
        `Step-up token rejected: sub mismatch (token=${payload.sub}, user=${user.id})`,
      );
      throw new ForbiddenException({
        code: "STEP_UP_INVALID",
        message: "Step-up token does not belong to this user",
        purpose: requiredPurpose,
      });
    }

    return true;
  }
}
