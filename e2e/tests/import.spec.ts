import { test, expect } from '../fixtures';
import { createAccount } from '../helpers/factories';
import { uniqueId } from '../helpers/api';
import { chooseIconSelectOption } from '../helpers/select';

test.describe('Import Transactions', () => {
  test('navigates to the import page', async ({ authedPage: page }) => {
    await page.goto('/import');
    await expect(page.locator('body')).toContainText(/import transactions/i);
  });

  test('shows the upload step by default', async ({ authedPage: page }) => {
    await page.goto('/import');

    await expect(
      page.getByText(/upload transaction files/i).first(),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.getByText(/select one or more files to import/i).first(),
    ).toBeVisible();
  });

  test('shows the multi-format file input', async ({ authedPage: page }) => {
    await page.goto('/import');

    await expect(
      page.getByText(/upload transaction files/i).first(),
    ).toBeVisible({ timeout: 10000 });
    await expect(
      page.locator('input[type="file"][accept=".qif,.qmtf,.ofx,.qfx,.csv,.mny,.kmy,.xml"]'),
    ).toBeAttached();
  });

  test('imports a QIF file end to end', async ({ authedPage: page, api }) => {
    const account = await createAccount(api, { name: `Import Target ${uniqueId()}` });
    // Minimal QIF bank file: one uncategorized transaction (no category lines,
    // so the wizard skips the mapping steps). Day 25 > 12 forces MM/DD/YYYY.
    const qif = ['!Type:Bank', 'D05/25/2026', 'T-42.00', 'PE2E Imported Payee', '^', ''].join('\n');

    await page.goto('/import');
    await page.locator('input[type="file"]').setInputFiles({
      name: 'e2e-import.qif',
      mimeType: 'text/plain',
      buffer: Buffer.from(qif),
    });

    // Server parses the file, then the wizard advances to account selection.
    await expect(
      page.getByRole('heading', { name: /select destination account/i }),
    ).toBeVisible({ timeout: 15000 });
    await chooseIconSelectOption(page.getByLabel(/import into account/i), { value: account.id });
    await page.getByRole('button', { name: /^next$/i }).click();

    // Review -> import.
    await expect(
      page.getByRole('heading', { name: /review import/i }),
    ).toBeVisible({ timeout: 10000 });
    await page.getByRole('button', { name: /import transactions/i }).click();

    // Completion summary reports one imported transaction.
    await expect(
      page.getByRole('heading', { name: /import complete/i }),
    ).toBeVisible({ timeout: 15000 });
    await expect(page.locator('li', { hasText: /imported:/i })).toContainText('1');
  });
});
