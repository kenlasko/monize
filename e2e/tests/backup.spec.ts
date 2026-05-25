import { test, expect } from '../fixtures';
import { createAccount } from '../helpers/factories';
import { uniqueId } from '../helpers/api';

// Backup & restore. Export downloads a gzipped JSON of all the user's data
// (no password prompt unless encrypted backups are enabled, which they are not
// by default). Restore wipes the current data and replaces it with the backup
// contents. Each test runs as its own isolated user, so the wipe only affects
// that user.
test.describe('Backup & restore', () => {
  test('exports a backup file', async ({ authedPage: page, api }) => {
    await createAccount(api, { name: `Backup ${uniqueId()}` });

    await page.goto('/settings');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download Backup' }).click();
    const download = await downloadPromise;

    expect(download.suggestedFilename()).toMatch(/monize-backup.*\.(json\.gz|gz)/);
  });

  test('restores data from a backup (round-trip)', async ({
    authedPage: page,
    api,
    user,
  }) => {
    const account = await createAccount(api, { name: `RoundTrip ${uniqueId()}` });

    await page.goto('/settings');
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download Backup' }).click();
    const filePath = await (await downloadPromise).path();

    // Delete the account, then restore the backup (taken while it existed).
    await api.delete(`/accounts/${account.id}`);

    await page.getByRole('button', { name: 'Restore from Backup...' }).click();
    await page.setInputFiles('#backup-file-input', filePath);
    await page.getByPlaceholder('Enter your password').fill(user.password);
    await page.getByRole('button', { name: 'Confirm Restore' }).click();

    // The wiped-then-restored data brings the account back.
    await page.goto('/accounts');
    await expect(page.locator('tr', { hasText: account.name })).toBeVisible({
      timeout: 15000,
    });
  });
});
