import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";

export const SKIP_PASSWORD_CHECK_KEY = "skipPasswordCheck";

@Injectable()
export class MustChangePasswordGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const skip = this.reflector.getAllAndOverride<boolean>(
      SKIP_PASSWORD_CHECK_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (skip) {
      return true;
    }

    const { user } = context.switchToHttp().getRequest();
    if (!user) {
      return true;
    }

    if (user.mustChangePassword) {
      throw new ForbiddenException(
        "Password change required before accessing this resource",
      );
    }

    return true;
  }
}
