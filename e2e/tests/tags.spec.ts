import { test, expect } from '../fixtures';
import { createTag } from '../helpers/factories';
import { uniqueId } from '../helpers/api';

// Full CRUD matrix for Tags. Preconditions are seeded via the API; the
// behaviour under test is driven through the UI and re-checked after a reload
// to prove real persistence.
test.describe('Tags', () => {
  test('creates a tag through the UI', async ({ authedPage: page }) => {
    const name = `E2E Create ${uniqueId()}`;

    await page.goto('/tags');
    await page.getByRole('button', { name: /new tag/i }).first().click();

    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/tag name/i).fill(name);
    await dialog.getByRole('button', { name: /create tag/i }).click();

    await expect(page.locator('tr', { hasText: name })).toBeVisible();
    // Persisted, not just optimistic UI.
    await page.reload();
    await expect(page.locator('tr', { hasText: name })).toBeVisible();
  });

  test('lists tags seeded via the API', async ({ authedPage: page, api }) => {
    const alpha = await createTag(api, { name: `Alpha ${uniqueId()}` });
    const bravo = await createTag(api, { name: `Bravo ${uniqueId()}` });

    await page.goto('/tags');

    await expect(page.locator('tr', { hasText: alpha.name })).toBeVisible();
    await expect(page.locator('tr', { hasText: bravo.name })).toBeVisible();
  });

  test('edits a tag through the UI', async ({ authedPage: page, api }) => {
    const tag = await createTag(api, { name: `Edit Me ${uniqueId()}` });
    const newName = `Edited ${uniqueId()}`;

    await page.goto('/tags');
    await page
      .locator('tr', { hasText: tag.name })
      .getByRole('button', { name: 'Edit', exact: true })
      .click();

    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/tag name/i).fill(newName);
    await dialog.getByRole('button', { name: /update tag/i }).click();

    await expect(page.locator('tr', { hasText: newName })).toBeVisible();
    await page.reload();
    await expect(page.locator('tr', { hasText: newName })).toBeVisible();
    await expect(page.locator('tr', { hasText: tag.name })).toHaveCount(0);
  });

  test('deletes a tag through the UI', async ({ authedPage: page, api }) => {
    const tag = await createTag(api, { name: `Delete Me ${uniqueId()}` });

    await page.goto('/tags');
    await page
      .locator('tr', { hasText: tag.name })
      .getByRole('button', { name: 'Delete', exact: true })
      .click();

    // Confirm in the dialog (scoped so it isn't the row's Delete button).
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Delete', exact: true })
      .click();

    await expect(page.locator('tr', { hasText: tag.name })).toHaveCount(0);
    await page.reload();
    await expect(page.locator('tr', { hasText: tag.name })).toHaveCount(0);
  });

  test('rejects an empty tag name', async ({ authedPage: page }) => {
    await page.goto('/tags');
    await page.getByRole('button', { name: /new tag/i }).first().click();

    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: /create tag/i }).click();

    await expect(dialog.getByText(/tag name is required/i)).toBeVisible();
  });
});
