import { test, expect } from '../fixtures';

// Ctrl/Cmd+K and a bare "?" open a search dialog over the bundled guide from
// any screen (docs/future-plans/in-app-help-search.md). The guide ships in
// the backend image, so this runs offline like help-panel.spec.ts.
test.describe('Help search', () => {
  test('"?" on Transactions lists the Transactions sections at once, and Enter opens one', async ({
    authedPage: page,
  }) => {
    await page.goto('/transactions');
    await expect(page.getByRole('heading', { level: 1, name: 'Transactions' })).toBeVisible();

    await page.keyboard.press('?');

    const dialog = page.getByRole('dialog', { name: 'Search the guide' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Help for this screen')).toBeVisible();
    // The current screen's own sections, with no query typed.
    await expect(dialog.getByRole('option', { name: 'Overview' })).toBeVisible();

    await page.keyboard.press('Enter');

    await expect(dialog).toBeHidden();
    const panel = page.getByRole('complementary', { name: 'Help' });
    await expect(panel.getByRole('heading', { level: 2, name: 'Transactions', exact: true })).toBeVisible();
    const section = panel.getByRole('heading', { name: 'Overview', exact: true });
    await expect(section).toBeVisible();
    await expect(section).toBeFocused();
    // The Transactions page is still beside it.
    await expect(page.getByRole('heading', { level: 1, name: 'Transactions' })).toBeVisible();
  });

  test('typing finds a section on another page, ranked by relevance, and Enter opens it', async ({
    authedPage: page,
  }) => {
    await page.goto('/transactions');
    await expect(page.getByRole('heading', { level: 1, name: 'Transactions' })).toBeVisible();

    await page.keyboard.press('?');
    const dialog = page.getByRole('dialog', { name: 'Search the guide' });
    const box = dialog.getByRole('combobox', { name: 'Search the guide' });
    await box.fill('restore from backup');

    const result = dialog.getByRole('option', { name: /Restoring from a Backup/ });
    await expect(result).toBeVisible();
    await page.keyboard.press('Enter');

    await expect(dialog).toBeHidden();
    const panel = page.getByRole('complementary', { name: 'Help' });
    await expect(
      panel.getByRole('heading', { level: 2, name: 'Backup and Restore', exact: true }),
    ).toBeVisible();
    await expect(panel.getByRole('heading', { name: 'Restoring from a Backup', exact: true })).toBeFocused();
  });

  test('Escape closes the search dialog without opening anything', async ({ authedPage: page }) => {
    await page.goto('/transactions');
    await expect(page.getByRole('heading', { level: 1, name: 'Transactions' })).toBeVisible();
    await page.keyboard.press('?');
    const dialog = page.getByRole('dialog', { name: 'Search the guide' });
    await expect(dialog).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(dialog).toBeHidden();
    await expect(page.getByRole('complementary', { name: 'Help' })).toBeHidden();
  });

  test('typing "?" into a text field types a question mark, not a search dialog', async ({
    authedPage: page,
  }) => {
    await page.goto('/transactions');
    await expect(page.getByRole('heading', { level: 1, name: 'Transactions' })).toBeVisible();

    // The register's own search box (payee:costco, #10, ...) is an ordinary
    // text field a reader can legitimately end with a question mark.
    const search = page.getByRole('textbox', { name: 'Search' });
    await search.pressSequentially('Who?');

    await expect(search).toHaveValue('Who?');
    await expect(page.getByRole('dialog', { name: 'Search the guide' })).toHaveCount(0);
  });
});
