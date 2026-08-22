import { type Page, expect } from '@playwright/test';
import { authenticator } from 'otplib';

// Log in as an EXISTING user (never register, never seed). Mirrors the shape
// of ../e2e/helpers/auth.ts loginUser, but adds optional TOTP and does not
// assume a fresh database. Credentials come from regression.env via the
// environment the Playwright process was started with.

export interface RegressionUser {
  email: string;
  password: string;
  totpSecret?: string;
}

export function userFromEnv(): RegressionUser {
  const email = process.env.MONIZE_USER_EMAIL;
  const password = process.env.MONIZE_USER_PASSWORD;
  if (!email || !password) {
    throw new Error(
      'MONIZE_USER_EMAIL and MONIZE_USER_PASSWORD must be set (see regression.env). ' +
        'This harness logs in as an existing user and never registers one.',
    );
  }
  return { email, password, totpSecret: process.env.MONIZE_USER_TOTP_SECRET || undefined };
}

/**
 * Drive the real login form. If the account has 2FA enabled, a TOTP secret
 * must be supplied so the harness can compute the current code; otherwise the
 * login stalls at the verification step and we fail loudly with guidance.
 */
export async function loginExistingUser(page: Page, user: RegressionUser): Promise<void> {
  await page.goto('/login');
  await page.waitForURL(/\/login/, { timeout: 15000 });

  await page.getByLabel(/email/i).fill(user.email);
  await page.getByLabel(/password/i).fill(user.password);
  // Exact match: the OIDC/SSO login page also renders a "Sign in with SSO"
  // button, so /sign in/i is ambiguous. We drive the local-credentials button.
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();

  // Race three outcomes: straight to the dashboard, a 2FA prompt, or an error.
  const codeField = page.getByLabel(/verification code|authenticator|one-time|2fa|code/i).first();
  await Promise.race([
    page.waitForURL(/\/dashboard/, { timeout: 15000 }).catch(() => {}),
    codeField.waitFor({ state: 'visible', timeout: 15000 }).catch(() => {}),
  ]);

  if (!/\/dashboard/.test(page.url()) && (await codeField.isVisible().catch(() => false))) {
    if (!user.totpSecret) {
      throw new Error(
        `Login for ${user.email} requires a 2FA code, but MONIZE_USER_TOTP_SECRET is not set. ` +
          `Add the account's TOTP secret to regression.env, or use an account without 2FA.`,
      );
    }
    const token = authenticator.generate(user.totpSecret);
    await codeField.fill(token);
    await page
      .getByRole('button', { name: /verify|continue|sign in|submit/i })
      .first()
      .click();
  }

  await expect(
    page,
    `Login did not reach the dashboard for ${user.email}. Check the credentials and 2FA secret in regression.env.`,
  ).toHaveURL(/\/dashboard/, { timeout: 20000 });
}
