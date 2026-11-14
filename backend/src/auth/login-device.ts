import * as crypto from "crypto";

import { tokenHashesEqual } from "./crypto.util";

/**
 * Per-account login throttling that a stranger cannot turn against the owner
 * (kenlasko/monize#2181).
 *
 * The password lockout (`./login-lockout`) counts every failure for an account
 * whatever IP it came from, so spreading guesses over many addresses buys an
 * attacker nothing. Left alone it is also a lever: anyone who knows the address
 * can keep the owner locked out. A browser that has signed in to the account
 * before carries a signed per-account `login_device_*` cookie, and while the
 * account is under a password lock a login from it is let through to the
 * password check on a budget of its own (`LOGIN_DEVICE_FAILURE_LIMIT`); past
 * that budget the lock refuses it too. So:
 *
 * - failures from unknown devices, from however many IPs, stop at the lock;
 * - that lock does not shut the owner out of a browser they already use;
 * - a copied cookie gives at most `LOGIN_DEVICE_FAILURE_LIMIT` guesses per
 *   quiet window, authenticates nothing, and dies with the password it was
 *   issued under or after `LOGIN_DEVICE_MAX_AGE_MS`, whichever comes first.
 *
 * The value is `iat.nonce.mac`, `mac = HMAC-SHA256(key, userId.iat.nonce.
 * passwordHash)`. Stateless: binding the stored bcrypt hash means every path
 * that replaces the password (INV-AUTH-005) revokes every cookie with no table,
 * and `iat` bounds its life on the server, not only in the browser. The name
 * carries an HMAC of the account id, so accounts sharing a browser each keep
 * their own cookie and the name reveals nothing about whose it is.
 */
export const LOGIN_DEVICE_COOKIE_PREFIX = "login_device_";

/** How long a browser stays known without signing in again. */
export const LOGIN_DEVICE_MAX_AGE_MS = 180 * 24 * 60 * 60 * 1000; // 180 days

/** `AuthAttemptCounterService` scope for a known device's own failures. */
export const LOGIN_DEVICE_SCOPE = "login-device";

/** Failures one known device may make under a lock before it is refused too. */
export const LOGIN_DEVICE_FAILURE_LIMIT = 10;

/** Sliding window for that budget: it lapses only after a quiet day. */
export const LOGIN_DEVICE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours

const NONCE_BYTES = 16;

function hmac(key: string, data: string): string {
  return crypto.createHmac("sha256", key).update(data).digest("base64url");
}

/** The cookie name that holds `userId`'s known-device marker. */
export function loginDeviceCookieName(key: string, userId: string): string {
  return `${LOGIN_DEVICE_COOKIE_PREFIX}${hmac(key, `name.${userId}`).slice(0, 22)}`;
}

/** Mint a value marking this browser as known for `userId` under this hash. */
export function issueLoginDeviceCookie(
  key: string,
  userId: string,
  passwordHash: string,
  now: number = Date.now(),
): string {
  const iat = Math.floor(now / 1000).toString(36);
  const nonce = crypto.randomBytes(NONCE_BYTES).toString("base64url");
  return `${iat}.${nonce}.${hmac(key, `${userId}.${iat}.${nonce}.${passwordHash}`)}`;
}

/**
 * True when `value` was minted for `userId` under `passwordHash` and is younger
 * than `LOGIN_DEVICE_MAX_AGE_MS`.
 */
export function verifyLoginDeviceCookie(
  key: string,
  userId: string,
  passwordHash: string,
  value: unknown,
  now: number = Date.now(),
): boolean {
  if (typeof value !== "string") return false;
  const [iat, nonce, given, ...rest] = value.split(".");
  if (!iat || !nonce || !given || rest.length > 0) return false;
  const issuedMs = parseInt(iat, 36) * 1000;
  if (
    !Number.isFinite(issuedMs) ||
    issuedMs > now + 60_000 ||
    now - issuedMs > LOGIN_DEVICE_MAX_AGE_MS
  ) {
    return false;
  }
  return tokenHashesEqual(
    hmac(key, `${userId}.${iat}.${nonce}.${passwordHash}`),
    given,
  );
}
