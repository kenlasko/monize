/**
 * Resolve a throttler request limit.
 *
 * Auth and global endpoints are deliberately rate-limited to resist brute
 * force. `RATE_LIMIT_MAX` lets a throwaway environment (e.g. the E2E stack,
 * where a whole suite of registrations/logins from one IP would otherwise trip
 * the limits) raise every cap to at least its value. When the variable is
 * unset -- as in production -- the secure per-endpoint defaults apply
 * unchanged. The override only ever raises a limit, never lowers it.
 */
export function rateLimit(defaultLimit: number): number {
  const override = Number(process.env.RATE_LIMIT_MAX);
  return Number.isFinite(override) && override > defaultLimit
    ? override
    : defaultLimit;
}
