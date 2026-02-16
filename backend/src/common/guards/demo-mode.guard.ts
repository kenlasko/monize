import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { DemoModeService } from "../demo-mode.service";

export const DEMO_RESTRICTED_KEY = "demoRestricted";

@Injectable()
export class DemoModeGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private demoModeService: DemoModeService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (!this.demoModeService.isDemo) {
      return true;
    }

    const isRestricted = this.reflector.getAllAndOverride<boolean>(
      DEMO_RESTRICTED_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (isRestricted) {
      throw new ForbiddenException(
        "This action is not available in demo mode.",
      );
    }

    return true;
  }
}
