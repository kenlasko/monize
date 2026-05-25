import { test, expect } from '../fixtures';

// Emergency access lets an owner designate contacts who gain access after a
// period of inactivity. The whole feature is gated on a configured mailer (the
// enable toggle, "Save settings" and "Add contact" are disabled when email is
// unavailable) and the grant is time-driven (min 2 days, cron-checked) with an
// emailed magic-link claim. The e2e stack has no SMTP and no exposed DB, so the
// settings/contacts mutations and the claim flow can't be exercised -- they're
// deferred (see ROADMAP Phase 3.2). This locks in that the page renders.
test.describe('Emergency access', () => {
  test('renders the settings page', async ({ authedPage: page }) => {
    await page.goto('/settings/emergency-access');

    await expect(
      page.getByRole('heading', { name: 'Emergency Access' }),
    ).toBeVisible({ timeout: 15000 });
  });
});
