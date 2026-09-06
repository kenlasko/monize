import { test, expect } from '../fixtures';
import { createCategory, createAccount, createTransaction } from '../helpers/factories';
import { uniqueId, type ApiClient } from '../helpers/api';

// The category detail page (/categories/[id]): the page a category row now
// opens. Seeded through the API, asserted through the UI -- a component test
// mocks the endpoint and so cannot catch a page that renders the wrong field
// or a route that never opens.
test.describe('Category detail', () => {
  /** A parent category with one child and a few transactions across both. */
  async function seedCategoryWithHistory(api: ApiClient) {
    const category = await createCategory(api, { name: `Detail ${uniqueId()}` });
    const child = await createCategory(api, {
      name: `Child ${uniqueId()}`,
      parentId: category.id,
    });
    const account = await createAccount(api, { name: `Chequing ${uniqueId()}` });
    for (const [amount, categoryId] of [
      [-25.5, category.id],
      [-18.25, child.id],
      [-42, category.id],
    ] as const) {
      await createTransaction(api, {
        accountId: account.id,
        amount,
        categoryId,
      });
    }
    return { category, child, account };
  }

  test('opens from the categories list when a row is clicked', async ({
    authedPage: page,
    api,
  }) => {
    const { category } = await seedCategoryWithHistory(api);

    await page.goto('/categories');
    await page.locator('tr', { hasText: category.name }).first().click();

    await expect(page).toHaveURL(new RegExp(`/categories/${category.id}$`));
    await expect(page.getByRole('heading', { name: category.name })).toBeVisible();
  });

  test('shows the summary cards and overview panels', async ({
    authedPage: page,
    api,
  }) => {
    const { category, account } = await seedCategoryWithHistory(api);

    await page.goto(`/categories/${category.id}`);

    await expect(page.getByRole('heading', { name: category.name })).toBeVisible();
    await expect(page.getByText('Spent This Year')).toBeVisible();
    await expect(page.getByText('Monthly Average')).toBeVisible();
    await expect(page.getByText('Top Payees')).toBeVisible();
    // The per-account breakdown comes from the detail aggregate, so the
    // account the transactions were entered in has to appear by name.
    await expect(page.getByText('Paid From Accounts')).toBeVisible();
    await expect(page.getByText(account.name).first()).toBeVisible();
  });

  test('counts the whole subtree in the Transactions tab', async ({
    authedPage: page,
    api,
  }) => {
    const { category, account } = await seedCategoryWithHistory(api);

    await page.goto(`/categories/${category.id}`);
    await page.getByRole('tab', { name: 'Transactions' }).click();

    // Scoped to the panel: "Transactions" is also a tab label and a summary
    // card, and the Overview panel stays mounted (hidden) behind this one.
    const panel = page.getByRole('tabpanel', { name: 'Transactions' });
    // Three seeded rows -- two on the category, one on its child. A count of
    // two here would mean the subtree expansion was lost.
    await expect(panel.getByText('Transactions (3)')).toBeVisible();
    await expect(
      panel.getByRole('button', { name: 'Open in the register' }),
    ).toBeVisible();
    await expect(panel.getByText(account.name).first()).toBeVisible();
  });

  test('lists the children on the Subcategories tab and drills into one', async ({
    authedPage: page,
    api,
  }) => {
    const { category, child } = await seedCategoryWithHistory(api);

    await page.goto(`/categories/${category.id}?tab=subcategories`);

    await expect(
      page.getByRole('tab', { name: 'Subcategories', selected: true }),
    ).toBeVisible();
    const panel = page.getByRole('tabpanel', { name: 'Subcategories' });
    await panel.getByText(child.name).click();

    await expect(page).toHaveURL(new RegExp(`/categories/${child.id}$`));
    await expect(page.getByRole('heading', { name: child.name })).toBeVisible();
  });

  test('hides the Subcategories tab for a leaf category', async ({
    authedPage: page,
    api,
  }) => {
    const { child } = await seedCategoryWithHistory(api);

    // A deep link to the tab a leaf does not have falls back to the overview.
    await page.goto(`/categories/${child.id}?tab=subcategories`);

    await expect(page.getByRole('heading', { name: child.name })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'Subcategories' })).toHaveCount(0);
    await expect(
      page.getByRole('tab', { name: 'Overview', selected: true }),
    ).toBeVisible();
  });

  test('links out to the filtered register', async ({ authedPage: page, api }) => {
    const { category } = await seedCategoryWithHistory(api);

    await page.goto(`/categories/${category.id}`);
    await page.getByRole('button', { name: 'View Transactions' }).click();

    await expect(page).toHaveURL(
      new RegExp(`/transactions\\?categoryId=${category.id}`),
    );
  });

  test('edits the category from the detail page and persists the change', async ({
    authedPage: page,
    api,
  }) => {
    const { category } = await seedCategoryWithHistory(api);
    const newName = `Renamed ${uniqueId()}`;

    await page.goto(`/categories/${category.id}`);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/category name/i).fill(newName);
    await dialog.getByRole('button', { name: /update category/i }).click();

    await expect(page.getByRole('heading', { name: newName })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: newName })).toBeVisible();
  });

  test('shows the error panel for an unknown category id', async ({
    authedPage: page,
  }) => {
    // A well-formed uuid that belongs to nobody: the route resolves, the
    // aggregate 404s, and the page has to say so rather than render blank.
    await page.goto('/categories/00000000-0000-4000-8000-000000000000');

    // Scoped to the page's <main>: Next's route announcer is a second
    // `role="alert"` on every hydrated page, so a page-wide alert locator is
    // ambiguous and only ever passed by polling before the panel rendered.
    await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Back to Categories' }),
    ).toBeVisible();
  });
});
