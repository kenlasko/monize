import { isAxiosError } from 'axios';

/**
 * True when a failed sync tells the reader nothing about what it did: the
 * request timed out, never reached the server, or the server (or a gateway in
 * front of it) answered 5xx. The server may have committed rows before the
 * answer was lost, so the outcome is unknown, not "nothing was imported". A 4xx
 * is the server refusing before it wrote anything, and is not unknown.
 */
export function isUnknownSyncOutcome(error: unknown): boolean {
  if (!isAxiosError(error)) return false;
  const status = error.response?.status;
  return status === undefined || status >= 500;
}
