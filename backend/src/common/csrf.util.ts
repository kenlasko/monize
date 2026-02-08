import * as crypto from 'crypto';

export function generateCsrfToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function getCsrfCookieOptions(isProduction: boolean) {
  return {
    httpOnly: false, // Must be readable by JavaScript for double-submit pattern
    secure: isProduction,
    sameSite: 'lax' as const,
    maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days (matches auth token)
    path: '/',
  };
}
