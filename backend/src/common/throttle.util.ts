/**
 * Resolve a throttler request limit.
 *
 * Auth and global endpoints are deliberately rate-limited to resist brute
 * force. `RATE_LIMIT_MAX` lets an operator raise every cap to at least its
 * value -- useful when many users share one egress IP (corporate NAT, VPN,
 * reverse proxy) or for throwaway environments like the E2E stack, where a
 * whole suite of registrations/logins from one IP would otherwise trip the
 * limits. When the variable is unset -- as in a default production deploy --
 * the secure per-endpoint defaults apply unchanged. As a safety guard the
 * override only ever raises a limit, never lowers it below the secure default.
 */
export function rateLimit(defaultLimit: number): number {
  const override = Number(process.env.RATE_LIMIT_MAX);
  return Number.isFinite(override) && override > defaultLimit
    ? override
    : defaultLimit;
}
