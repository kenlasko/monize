import { HttpException, HttpStatus } from "@nestjs/common";
import { AuthAttemptCounterService } from "../auth/auth-attempt-counter.service";
import { tr } from "../i18n/translate";

/**
 * Explicit fetches a user may make per window, on every entry point (REST, the
 * assistant, MCP): each may read the issuer's site. The counter is the shared
 * `auth_attempt_counters` row, so replicas agree, and an attempt counts whether
 * it succeeds, finds the series stored or fails.
 */
export const SERIES_FETCH_LIMIT = 10;
export const SERIES_FETCH_WINDOW_MS = 60_000;
export const SERIES_FETCH_SCOPE = "bond-series-fetch";

/**
 * One explicit request to an issuer's site against the user's per-minute
 * allowance, before anything is read or requested: the attempt is counted
 * first, so a failed one is charged like a successful one and the refused one
 * sends no request. A series fetch and an auction listing share the allowance.
 */
export async function chargeSeriesFetchAttempt(
  attempts: Pick<AuthAttemptCounterService, "increment">,
  userId: string,
): Promise<void> {
  const { count } = await attempts.increment(
    SERIES_FETCH_SCOPE,
    userId,
    SERIES_FETCH_WINDOW_MS,
    "fixed",
  );
  if (count > SERIES_FETCH_LIMIT) {
    throw new HttpException(
      {
        message: tr(
          "errors.bonds.SERIES_FETCH_RATE_LIMITED",
          `At most ${SERIES_FETCH_LIMIT} bond series can be fetched per minute; wait a minute and try again.`,
          { limit: String(SERIES_FETCH_LIMIT) },
        ),
        errorCode: "SERIES_FETCH_RATE_LIMITED",
      },
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
