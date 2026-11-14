import {
  CallHandler,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
} from "@nestjs/common";
import { Observable, from, switchMap } from "rxjs";
import { DataSource, EntityTarget, ObjectLiteral, Repository } from "typeorm";
import { withScopedDb } from "../../common/db/scoped-db";
import { Request } from "express";
import { User } from "../../users/entities/user.entity";
import { UserPreference } from "../../users/entities/user-preference.entity";
import { requestContextStorage } from "../request-context";
import { withUserContext } from "../db/with-context";
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

  constructor(private readonly dataSource: DataSource) {}

  /**
   * One repository call in its own short scoped transaction -- the RLS-era
   * replacement for the injected repositories this class used to hold, with the
   * same autocommit boundary each of those calls had. Multi-statement units use
   * an explicit `withScopedDb` block so their statements share one transaction.
   */
  private scoped<E extends ObjectLiteral, T>(
    entity: EntityTarget<E>,
    fn: (repo: Repository<E>) => Promise<T>,
  ): Promise<T> {
    return withScopedDb(this.dataSource, (manager) =>
      fn(manager.getRepository(entity)),
    );
  }

  /**
   * Record that a human interactively used Monize.
   *
   * `realUserId` -- the authenticated identity -- is deliberately the subject,
   * not the effective user. While a delegate acts, the effective user is the
   * OWNER, and stamping the owner's row would make the delegate's traffic
   * indistinguishable from the owner signing in. Emergency access measures
   * exactly that: an owner who configures a 30-day waiting period and stops
   * signing in never becomes eligible if a delegate keeps making requests, so a
   * delegate could suppress the owner's safety mechanism indefinitely, and the
   * activity record would attribute the delegate's session to the owner (P2-008).
   *
   * `users.last_activity_at` therefore answers one question -- when did *this*
   * person last interact -- and nothing else may be inferred from it. Tracking
   * "somebody accessed this owner's data" is a different question; it needs its
   * own column, and the emergency timer must never read it as an owner sign-in.
   */
  private touchLastActivity(realUserId: string): void {
    const now = Date.now();
    const last = this.lastActivityWrite.get(realUserId) ?? 0;
    if (now - last < ACTIVITY_WRITE_INTERVAL_MS) return;
    this.lastActivityWrite.set(realUserId, now);

    // RLS (task C6): this fire-and-forget write runs BEFORE the interceptor
    // enters its requestContextStorage scope (that scope needs the resolved
    // timezone, which is not known yet). Seed a user context here so the write
    // has ambient identity once this repository moves to withScopedDb (R7). Inert
    // at RLS_MODE=off. The authenticated user always reaches their own `users`
    // row: withUserContext puts the same id in both identity GUCs, and
    // `users_self` matches on either.
    withUserContext(realUserId, () =>
      this.scoped(User, (repo) =>
        repo.update({ id: realUserId }, { lastActivityAt: new Date(now) }),
      ),
    ).catch((err) => {
      // Roll the cached timestamp back so a transient failure does not
      // permanently silence activity tracking for this user.
      this.lastActivityWrite.delete(realUserId);
      this.logger.warn(
        `Failed to persist last_activity_at for user ${realUserId}: ${err?.message ?? err}`,
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
    const user = (
      request as unknown as {
        user?: { id?: string; realUserId?: string; pat?: unknown };
      }
    ).user;
    const userId: string | undefined = user?.id;
    // Authenticated identity (the delegate's own id while acting); defaults to
    // the effective user outside delegation. Seeded so withScopedDb can emit
    // app.real_user_id for delegate-keyed rows. jwt.strategy resolves it.
    const realUserId: string | undefined = user?.realUserId ?? userId;

    // A personal access token is a script, not a person at the keyboard
    // (`JwtStrategy.patUser` sets `pat`). Stamping its traffic would keep the
    // owner's emergency-access clock from ever running out.
    if (realUserId && !user?.pat) {
      this.touchLastActivity(realUserId);
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
            requestContextStorage.run({ userId, realUserId, timezone }, () => {
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
      // RLS (task C6): resolveTimezone runs BEFORE the interceptor's
      // requestContextStorage scope is entered (the scope needs this method's
      // result), so seed a user context around its reads/writes. Inert at
      // RLS_MODE=off -- same preference row, same fire-and-forget semantics.
      const pref = await withUserContext(userId, () =>
        this.scoped(UserPreference, (repo) =>
          repo.findOne({
            where: { userId },
          }),
        ),
      );
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
        withUserContext(userId, () =>
          this.scoped(UserPreference, (repo) =>
            repo.update({ userId }, { lastClientTimezone: headerTz }),
          ),
        ).catch((err) => {
          this.logger.warn(
            `Failed to persist last_client_timezone for user ${userId}: ${err?.message ?? err}`,
          );
        });
      }
    }
    return headerTz;
  }
}
