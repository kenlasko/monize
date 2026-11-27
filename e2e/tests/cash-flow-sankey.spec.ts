import { test, expect } from '../fixtures';
import {
  createAccount,
  createCategory,
  createTransaction,
} from '../helpers/factories';
import { uniqueId } from '../helpers/api';

// The Cash Flow Sankey: income into the hub and out to what it was spent on.
// Seeded through the API for a fresh user (today's rows, so the report's
// default "this month" range holds them); driven through the UI. The figures
// themselves are the backend suites' to prove -- this covers the route, the
// depth toggle and the drill-down into Transactions.
test.describe('Cash Flow Sankey report', () => {
  test('draws the month, toggles depth, and drills a category into Transactions', async ({
    authedPage: page,
    api,
  }) => {
    const account = await createAccount(api, {
      name: `Chequing ${uniqueId()}`,
      accountType: 'CHEQUING',
      openingBalance: 1000,
    });
    const salary = await createCategory(api, {
      name: `Salary ${uniqueId()}`,
      type: 'income',
    });
    const groceries = await createCategory(api, {
      name: `Groceries ${uniqueId()}`,
    });
    await createTransaction(api, {
      accountId: account.id,
      amount: 3000,
      categoryId: salary.id,
    });
    await createTransaction(api, {
      accountId: account.id,
      amount: -120,
      categoryId: groceries.id,
    });

    await page.goto('/reports/cash-flow-sankey');
    await expect(
      page.getByRole('heading', { name: 'Cash Flow Sankey' }),
    ).toBeVisible({ timeout: 15000 });

    // The diagram's accessible name states the totals.
    const diagram = page.getByRole('img', {
      name: /Cash flow diagram\. Income/,
    });
    await expect(diagram).toBeVisible({ timeout: 15000 });

    // Depth 2 is a toggle; the report asks again and keeps the diagram.
    const subcategories = page.getByRole('button', {
      name: 'Subcategories',
      exact: true,
    });
    await subcategories.click();
    await expect(subcategories).toHaveAttribute('aria-pressed', 'true');
    await expect(diagram).toBeVisible({ timeout: 15000 });

    // A category node drills into Transactions for that category and range.
    // The diagram is one role="img", so its nodes are pointer targets with no
    // role of their own; they are addressed by test id.
    await page
      .getByTestId(`sankey-node-expense:${groceries.id}`)
      .locator('text')
      .click();

    // Filtered to the category, the report's scope and its range (this month).
    await page.waitForURL(
      (url) =>
        url.pathname === '/transactions' &&
        url.searchParams.get('categoryId') === groceries.id &&
        (url.searchParams.get('accountIds') ?? '')
          .split(',')
          .includes(account.id) &&
        /^\d{4}-\d{2}-01$/.test(url.searchParams.get('startDate') ?? '') &&
        /^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get('endDate') ?? ''),
      { timeout: 15000 },
    );
  });
});
