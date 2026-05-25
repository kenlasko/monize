import { test, expect } from '../fixtures';
import { logout } from '../helpers/auth';
import { generateTotp } from '../helpers/totp';

// 2FA (TOTP) and the password-reset surfaces. FORCE_2FA is false in
// docker-compose.e2e.yml, so 2FA is opt-in per test. Enabling is done through
// the API (POST /auth/2fa/setup returns the base32 secret, confirm-setup
// promotes it) so the test owns the secret and can generate codes; the
// login-with-2FA and disable flows are then driven through the UI.
test.describe('Two-factor authentication', () => {
  async function enable2FA(
    api: { post<T = unknown>(path: string, body?: unknown): Promise<T> },
    password: string,
  ): Promise<string> {
    const { secret } = await api.post<{ secret: string }>('/auth/2fa/setup', {
      currentPassword: password,
    });
    await api.post('/auth/2fa/confirm-setup', { code: generateTotp(secret) });
    return secret;
  }

  test('reflects the enabled state in settings', async ({
    authedPage: page,
    api,
    user,
  }) => {
    await enable2FA(api, user.password);

    await page.goto('/settings');
    await expect(
      page.getByRole('heading', { name: 'Security', exact: true }),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByRole('button', { name: 'Disable 2FA' }),
    ).toBeVisible();
  });

  test('requires a second factor at login when enabled', async ({
    authedPage: page,
    api,
    user,
  }) => {
    const secret = await enable2FA(api, user.password);
    // Generate backup codes now (one TOTP, used immediately like the disable
    // flow). Logging in with a backup code is deterministic -- it avoids the
    // 30s TOTP window boundary that makes a generated-then-typed code flaky.
    const { codes } = await api.post<{ codes: string[] }>(
      '/auth/2fa/backup-codes',
      { code: generateTotp(secret) },
    );

    await logout(page);
    await page.waitForURL(/\/login/);
    await page.getByLabel('Email address').fill(user.email);
    await page.getByLabel('Password', { exact: true }).fill(user.password);
    await page.getByRole('button', { name: 'Sign in' }).click();

    // The login response demands the second factor before issuing a session.
    const backupToggle = page.getByRole('button', {
      name: /use a backup code instead/i,
    });
    await expect(backupToggle).toBeVisible();
    await backupToggle.click();
    await page.getByLabel('Backup Code').fill(codes[0]);
    await page.getByRole('button', { name: 'Verify', exact: true }).click();

    await page.waitForURL(/\/dashboard/);
  });

  test('disables 2FA from settings', async ({ authedPage: page, api, user }) => {
    const secret = await enable2FA(api, user.password);

    await page.goto('/settings');
    await page.getByRole('button', { name: 'Disable 2FA' }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Verification Code').fill(generateTotp(secret));
    await dialog.getByRole('button', { name: 'Disable 2FA' }).click();

    // Back to the disabled state -- the enable affordance returns.
    await expect(page.getByRole('button', { name: 'Enable 2FA' })).toBeVisible();
  });
});

// Forgot/reset uses a stubbed mailer in the e2e stack (no SMTP, no exposed DB),
// so the raw reset token can't be retrieved -- the happy path is deferred (see
// ROADMAP Phase 2.4). These cover the parts that don't need the token: the
// request always returns a generic anti-enumeration message, and the reset
// page guards a missing/invalid token. Uses the unauthenticated base `page`.
test.describe('Password reset', () => {
  test('forgot-password shows a generic confirmation', async ({ page }) => {
    await page.goto('/forgot-password');
    await page.getByLabel('Email address').fill('nobody@test.example.com');
    await page.getByRole('button', { name: /send reset link/i }).click();

    await expect(
      page.getByText(/we have sent a password reset link/i),
    ).toBeVisible();
  });

  test('reset-password rejects a missing token', async ({ page }) => {
    await page.goto('/reset-password');

    await expect(
      page.getByText(/invalid or missing reset token/i),
    ).toBeVisible();
  });

  test('reset-password rejects an invalid token', async ({ page }) => {
    await page.goto('/reset-password?token=not-a-real-token');

    await page.getByLabel('New Password', { exact: true }).fill('FreshE2ePass123!');
    await page.getByLabel('Confirm Password', { exact: true }).fill('FreshE2ePass123!');
    await page.getByRole('button', { name: /reset password/i }).click();

    await expect(
      page.getByText(/invalid or expired reset token/i),
    ).toBeVisible();
  });
});
