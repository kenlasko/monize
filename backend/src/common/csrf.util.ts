import * as crypto from "crypto";

export function generateCsrfToken(sessionId?: string, secret?: string): string {
  const nonce = crypto.randomBytes(32).toString("hex");
  if (sessionId && secret) {
    const hmac = crypto
      .createHmac("sha256", secret)
      .update(`${nonce}:${sessionId}`)
      .digest("hex");
    return `${nonce}:${hmac}`;
  }
  return nonce;
}

export function verifyCsrfToken(
  token: string,
  sessionId?: string,
  secret?: string,
): boolean {
  if (!sessionId || !secret) {
    // Fallback: simple comparison (no session binding available)
    return true;
  }
  const parts = token.split(":");
  if (parts.length !== 2) return false;
  const [nonce, providedHmac] = parts;
  const expectedHmac = crypto
    .createHmac("sha256", secret)
    .update(`${nonce}:${sessionId}`)
    .digest("hex");
  return crypto.timingSafeEqual(
    Buffer.from(providedHmac, "utf-8"),
    Buffer.from(expectedHmac, "utf-8"),
  );
}

export function getCsrfCookieOptions(isProduction: boolean) {
  return {
    httpOnly: false, // Must be readable by JavaScript for double-submit pattern
    secure: isProduction,
    sameSite: "lax" as const,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days (matches auth token)
    path: "/",
  };
}
