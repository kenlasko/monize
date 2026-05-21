import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Observable, from, switchMap } from "rxjs";
import { Repository } from "typeorm";
import { Request } from "express";
import { User } from "../../users/entities/user.entity";
import { UserPreference } from "../../users/entities/user-preference.entity";
import { requestContextStorage } from "../request-context";
import { isValidIanaTimezone } from "../date-utils";

// Update last_activity_at at most once every 5 minutes per user so a busy
// session does not hammer the users table.
const ACTIVITY_WRITE_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Populates the request-scoped RequestContext with the authenticated user's
 * effective timezone so server-side "today" calculations respect the user's
 * local date, not the server's.
 *
 * Resolution order:
 *   1. user_preferences.timezone, if it is a real IANA name (anything other
 *      than the sentinel "browser" or blank).
 *   2. X-Client-Timezone header (sent by the frontend axios interceptor).
 *   3. Unset -- downstream code falls back to the server's local date.
 *
 * The context is entered around next.handle() so all async work kicked off
 * by the controller inherits the ALS scope.
 */
@Injectable()
export class RequestContextInterceptor implements NestInterceptor {
  private readonly logger = new Logger(RequestContextInterceptor.name);
  private readonly lastActivityWrite = new Map<string, number>();

  constructor(
    @InjectRepository(UserPreference)
    private readonly preferencesRepository: Repository<UserPreference>,
    @InjectRepository(User)
    private readonly usersRepository: Repository<User>,
  ) {}

  private touchLastActivity(userId: string): void {
    const now = Date.now();
    const last = this.lastActivityWrite.get(userId) ?? 0;
    if (now - last < ACTIVITY_WRITE_INTERVAL_MS) return;
    this.lastActivityWrite.set(userId, now);

    this.usersRepository
      .update({ id: userId }, { lastActivityAt: new Date(now) })
      .catch((err) => {
        // Roll the cached timestamp back so a transient failure does not
        // permanently silence activity tracking for this user.
        this.lastActivityWrite.delete(userId);
        this.logger.warn(
          `Failed to persist last_activity_at for user ${userId}: ${err?.message ?? err}`,
        );
      });
  }

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> | Promise<Observable<unknown>> {
    if (context.getType() !== "http") {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<Request>();
    const userId: string | undefined = (
      request as unknown as { user?: { id?: string } }
    ).user?.id;

    if (userId) {
      this.touchLastActivity(userId);
    }

    const rawHeader = request.headers["x-client-timezone"];
    const headerTz =
      typeof rawHeader === "string" && rawHeader.trim().length > 0
        ? rawHeader.trim()
        : undefined;

    return from(this.resolveTimezone(userId, headerTz)).pipe(
      switchMap(
        (timezone) =>
          new Observable<unknown>((subscriber) => {
            requestContextStorage.run({ userId, timezone }, () => {
              next.handle().subscribe({
                next: (value) => subscriber.next(value),
                error: (err) => subscriber.error(err),
                complete: () => subscriber.complete(),
              });
            });
          }),
      ),
    );
  }

  private async resolveTimezone(
    userId: string | undefined,
    headerTz: string | undefined,
  ): Promise<string | undefined> {
    if (userId) {
      const pref = await this.preferencesRepository.findOne({
        where: { userId },
      });
      const stored = pref?.timezone?.trim();
      if (stored && stored !== "browser") {
        return stored;
      }

      // User has no explicit timezone preference; cache the browser-reported
      // value so cron jobs (which have no request) can still compute "today"
      // in the user's actual local time. Fire-and-forget — never block the
      // request on the persistence write.
      if (
        isValidIanaTimezone(headerTz) &&
        pref?.lastClientTimezone !== headerTz
      ) {
        this.preferencesRepository
          .update({ userId }, { lastClientTimezone: headerTz })
          .catch((err) => {
            this.logger.warn(
              `Failed to persist last_client_timezone for user ${userId}: ${err?.message ?? err}`,
            );
          });
      }
    }
    return headerTz;
  }
}
