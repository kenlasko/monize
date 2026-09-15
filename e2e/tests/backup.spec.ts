import { test, expect } from '../fixtures';
import { createAccount } from '../helpers/factories';
import { uniqueId } from '../helpers/api';

// Backup & restore. Export downloads a backup of all the user's data.
//
// Backups are encrypted with the user's own password, captured when they
// register or sign in. `ENCRYPTION_KEY` is required for the backend to start at
// all, so there is no environment in which that capture silently does not
// happen -- this suite therefore drives the encrypted download, prompt and all
// (issue #1269, where the key was optional and every backup came out in clear).
//
// The restore round-trip wipes and replaces all data; driving it end-to-end in
// a browser is deferred (see ROADMAP Phase 3.4) -- the wipe appears to
// invalidate the active session, so asserting the restored data in the same
// page session isn't reliable. Restore is covered by backend tests.
test.describe('Backup & restore', () => {
  test('exports an encrypted backup, asking for the password first', async ({
    authedPage: page,
    api,
    user,
  }) => {
    await createAccount(api, { name: `Backup ${uniqueId()}` });

    await page.goto('/settings');

    // The account's login password was captured at registration, so Settings
    // reports encryption as on and the download asks for it before writing a
    // file only that password can open.
    await expect(page.getByText('Backup Encryption')).toBeVisible();
    // `exact` is load-bearing, not decoration: the panel's description ("Your
    // backups are encrypted with your login password. Nothing else to
    // remember...") CONTAINS the badge note, and getByText matches substrings,
    // so a loose locator resolves to two elements and fails strict mode. Match
    // the note's whole text and only the note matches.
    await expect(
      page.getByText('Backups are encrypted with your login password.', {
        exact: true,
      }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Download Backup' }).click();

    await expect(
      page.getByRole('heading', { name: 'Encrypt Backup' }),
    ).toBeVisible();
    await page.getByPlaceholder('Login password').fill(user.password);

    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download', exact: true }).click();
    const download = await downloadPromise;

    // `.mzbe` is the encrypted envelope; `.json.gz` would mean the capture did
    // not happen, which is the defect this suite exists to catch.
    expect(download.suggestedFilename()).toMatch(/monize-backup.*\.mzbe$/);
  });

  test('keeps automatic backup settings out of Settings for a non-admin', async ({
    authedPage: page,
  }) => {
    await page.goto('/settings');
    await expect(page.getByText('Create Backup')).toBeVisible();

    // Automatic backups are a deployment concern configured on the admin-only
    // Backups surface; a plain user's Settings has manual export/restore only,
    // and no automatic-backup schedule to set anywhere. Assert the admin
    // section heading "Automatic Backup" (singular) is absent, matching it
    // exactly: this page shows the user's own "Automatic Backups" (plural)
    // sub-section, and a substring name match would match that and misfire.
    // The Off-site destinations block folded under it also mentions automatic
    // backups in its prose, which is legitimate.
    await expect(
      page.getByRole('heading', { name: 'Automatic Backup', exact: true }),
    ).toHaveCount(0);
  });

  test('keeps automatic backup settings out of Settings for an admin too', async ({
    adminPage,
  }) => {
    // The IA split moved automatic-backup configuration onto Admin -> Backups,
    // so even an administrator no longer finds it stacked in their own Settings.
    // Match "Automatic Backup" (singular) exactly: this page always shows the
    // user's own "Automatic Backups" (plural) sub-section, which a substring
    // name match would match and misfire on. The Off-site destinations block
    // folded under it mentions automatic backups in its description.
    await adminPage.goto('/settings');
    await expect(adminPage.getByText('Create Backup')).toBeVisible();
    await expect(
      adminPage.getByRole('heading', { name: 'Automatic Backup', exact: true }),
    ).toHaveCount(0);
  });

  test('configures automatic backups on the admin Backups page', async ({
    adminPage,
  }) => {
    await adminPage.goto('/admin/backups');

    // The page must make the scope unambiguous: per-user artifacts, not a full
    // PostgreSQL/database dump.
    await expect(
      adminPage.getByRole('heading', { name: 'Not a full database backup' }),
    ).toBeVisible();
    await expect(
      adminPage.getByRole('heading', { name: 'Automatic Backup' }),
    ).toBeVisible();

    // The automatic-backup flow lives here now, so its controls do too.
    const folder = adminPage.getByLabel('Backup Folder');
    const validate = adminPage.getByRole('button', { name: 'Validate' });
    const save = adminPage.getByRole('button', { name: 'Save Settings' });
    await expect(folder).toBeVisible();
    await expect(adminPage.getByRole('switch')).toBeVisible();
    await expect(
      adminPage.getByRole('button', { name: 'Browse...' }),
    ).toBeVisible();
    await expect(save).toBeVisible();

    // The folder is pre-populated with the deployment default (`getSettings`
    // reports the resolved root even for an admin with no saved row), so
    // Validate is enabled from the start -- there is a legal path to probe even
    // before storage is proven writable. A non-empty path is the whole of the
    // gate: clearing the field disables Validate, and refilling it re-enables it.
    await expect(folder).not.toHaveValue('');
    await expect(validate).toBeEnabled();
    await folder.fill('');
    await expect(validate).toBeDisabled();
    await folder.fill('/data/backups');
    await expect(validate).toBeEnabled();

    // Exercise Save. A disabled schedule with a folder set does not need
    // writable storage, so the PATCH round-trips and the server then reports a
    // folder is configured -- which is exactly what makes Run Backup Now appear.
    await expect(save).toBeEnabled();
    await save.click();
    await expect(
      adminPage.getByRole('button', { name: 'Run Backup Now' }),
    ).toBeVisible();
  });

  test('disables the automatic-backup controls in demo mode', async ({
    adminPage,
  }) => {
    // The four mutating AutoBackupController endpoints are @DemoRestricted, so
    // the controls that reach them are disabled (not hidden) for a demo admin,
    // with the amber demo banner explaining why. This body only runs against a
    // deployment started with DEMO_MODE=true.
    test.skip(
      process.env.DEMO_MODE !== 'true',
      'requires a DEMO_MODE=true deployment',
    );

    await adminPage.goto('/admin/backups');

    await expect(
      adminPage.getByRole('heading', { name: 'Restricted in Demo Mode' }),
    ).toBeVisible();
    await expect(adminPage.getByRole('switch')).toBeDisabled();
    await expect(
      adminPage.getByRole('button', { name: 'Browse...' }),
    ).toBeDisabled();
    await expect(
      adminPage.getByRole('button', { name: 'Save Settings' }),
    ).toBeDisabled();
  });
});
