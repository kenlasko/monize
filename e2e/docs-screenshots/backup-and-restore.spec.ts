import { test, expect, type BrowserContext, type Page } from '@playwright/test';
import { apiFor, open, scrollUnderHeader } from '../readme/session';
import { cardOf, docShot, openAdminSession, openDocsSession } from './capture';

// website/docs/backup-and-restore.md.
//
// Nothing here downloads a backup or restores one: the export prompt, the
// restore form and the support backup dialog are opened, photographed and
// cancelled. The restore form is shown holding a file whose first bytes are an
// encrypted backup's signature, so it draws the extra password field; the file
// is never sent.
//
// The one write: when the server holds no automatic backups for the
// administrator yet, the admin's "Back Up Every Account Now" endpoint is called
// once, so the deployment status and each user's list of automatic backups have
// something to show. It writes a backup file per account into the backup store
// and changes no data.

interface StoredBackups {
  enabled: boolean;
  backups: unknown[];
}

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  const admin = await openAdminSession(browser);
  try {
    const adminPage = await admin.newPage();
    await adminPage.goto('/dashboard');
    const api = apiFor(adminPage);
    const stored = await api.get<StoredBackups>('/backup/stored-backups');
    if (stored.backups.length === 0) {
      await api.post('/backup/run-auto-backup');
    }
  } finally {
    await admin.close();
  }
  context = await openDocsSession(browser);
  page = await context.newPage();
});

test.afterAll(async () => {
  await context.close();
});

const backupCard = () => cardOf(page.getByRole('heading', { name: 'Backup & Restore', level: 2 }));

async function openBackupSection(): Promise<void> {
  await open(page, '/settings');
  const heading = page.getByRole('heading', { name: 'Backup & Restore', level: 2 });
  await expect(heading).toBeVisible({ timeout: 30_000 });
  await expect(backupCard().getByText('Enabled', { exact: true })).toBeVisible();
  await scrollUnderHeader(page, heading);
}

test('backup-restore-section', async () => {
  await openBackupSection();
  await docShot(page, 'backup-restore-section', backupCard());
});

test('backup-encryption-download', async () => {
  await openBackupSection();
  await backupCard().getByRole('button', { name: 'Download Backup' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Encrypt Backup' })).toBeVisible();
  await docShot(page, 'backup-encryption-download', dialog);
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
});

test('backup-restore-form', async () => {
  await openBackupSection();
  await backupCard().getByRole('button', { name: 'Restore from Backup...' }).click();
  await backupCard()
    .getByLabel('Select backup file')
    .setInputFiles({
      name: 'monize-backup-2026-10-01.mzbe',
      mimeType: 'application/octet-stream',
      buffer: Buffer.concat([Buffer.from('MZBE'), Buffer.alloc(124)]),
    });
  await expect(backupCard().getByText('This backup is encrypted.')).toBeVisible();
  const form = cardOf(backupCard().getByText('Warning: This will delete all your current data'));
  await scrollUnderHeader(page, form);
  await docShot(page, 'backup-restore-form', form);
  await backupCard().getByRole('button', { name: 'Cancel' }).click();
  await expect(backupCard().getByRole('button', { name: 'Restore from Backup...' })).toBeVisible();
});

test('backup-stored-list', async () => {
  await openBackupSection();
  const summary = page.getByTestId('stored-backups-summary');
  await expect(summary).toBeVisible({ timeout: 30_000 });
  await summary.click();
  await expect(
    backupCard().getByRole('button', { name: 'Restore', exact: true }).first(),
  ).toBeVisible({
    timeout: 30_000,
  });
  await scrollUnderHeader(page, summary);
  await docShot(page, 'backup-stored-list', summary.locator('xpath=..'));
});

test('backup-offsite-destinations', async () => {
  await openBackupSection();
  const summary = page.getByTestId('stored-backups-summary');
  await expect(summary).toBeVisible({ timeout: 30_000 });
  if ((await summary.locator('xpath=..').getAttribute('open')) === null) await summary.click();
  const offsite = page.getByTestId('offsite-destinations-summary');
  await offsite.click();
  await expect(page.getByText('S3 storage', { exact: true })).toBeVisible({ timeout: 30_000 });
  const details = offsite.locator('xpath=..');
  await scrollUnderHeader(page, offsite);
  await docShot(page, 'backup-offsite-destinations', details);
});

test.describe('the support backup dialog', () => {
  test.describe.configure({ mode: 'serial' });

  const dialog = () => page.getByRole('dialog');

  test('backup-support-dialog', async () => {
    // Tall enough for the whole dialog, which otherwise scrolls inside itself.
    await page.setViewportSize({ width: 1600, height: 1500 });
    await open(page, '/settings');
    await page.getByRole('button', { name: /Create a support backup/ }).click();
    await expect(dialog().getByRole('heading', { name: 'Create support backup' })).toBeVisible({
      timeout: 30_000,
    });
    await docShot(page, 'backup-support-dialog', dialog());
  });

  test('backup-support-preview', async () => {
    await dialog().getByRole('button', { name: 'Preview', exact: true }).click();
    await expect(dialog().getByText('Before', { exact: true }).first()).toBeVisible({
      timeout: 30_000,
    });
    const preview = dialog()
      .locator('p', { hasText: /^Preview$/ })
      .locator('xpath=..');
    await preview.scrollIntoViewIfNeeded();
    await docShot(page, 'backup-support-preview', preview);
    await dialog().getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog()).toBeHidden();
    await page.setViewportSize({ width: 1600, height: 1000 });
  });
});

test.describe('Admin > Backups', () => {
  test.describe.configure({ mode: 'serial' });

  let admin: BrowserContext;
  let adminPage: Page;

  test.beforeAll(async ({ browser }) => {
    admin = await openAdminSession(browser);
    adminPage = await admin.newPage();
  });

  test.afterAll(async () => {
    await admin.close();
  });

  test('backup-auto-settings', async () => {
    await open(adminPage, '/admin/backups');
    await expect(adminPage.getByRole('heading', { name: 'Automatic Backup' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      adminPage.getByRole('button', { name: 'Back Up Every Account Now' }),
    ).toBeVisible();
    await docShot(adminPage, 'backup-auto-settings');
  });

  test('backup-auto-status', async () => {
    const status = cardOf(adminPage.getByRole('heading', { name: 'Deployment Status' }));
    await expect(status).toBeVisible({ timeout: 30_000 });
    await status.scrollIntoViewIfNeeded();
    await docShot(adminPage, 'backup-auto-status', status);
  });

  test('backup-folder-browser', async () => {
    await scrollUnderHeader(adminPage, adminPage.getByRole('heading', { name: 'Backup Storage' }));
    await adminPage.getByRole('button', { name: 'Browse...' }).click();
    const select = adminPage.getByRole('button', { name: 'Select This Folder' });
    await expect(select).toBeVisible({ timeout: 30_000 });
    const panel = cardOf(select);
    await docShot(adminPage, 'backup-folder-browser', panel);
    await panel.getByRole('button', { name: 'Cancel' }).click();
    await expect(select).toBeHidden();
  });
});
