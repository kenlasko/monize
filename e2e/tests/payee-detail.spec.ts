import { test, expect } from '../fixtures';
import { createPayee, createAccount, createTransaction } from '../helpers/factories';
import { uniqueId, type ApiClient } from '../helpers/api';

// The payee detail page (/payees/[id]): the page a payee row now opens. Seeded
// through the API, asserted through the UI -- a component test mocks the
// endpoint and so cannot catch a page that renders the wrong field or a route
// that never opens.
test.describe('Payee detail', () => {
  /** A payee with a few transactions in one account. */
  async function seedPayeeWithHistory(api: ApiClient) {
    const payee = await createPayee(api, { name: `Detail ${uniqueId()}` });
    const account = await createAccount(api, { name: `Chequing ${uniqueId()}` });
    for (const amount of [-25.5, -18.25, -42]) {
      await createTransaction(api, {
        accountId: account.id,
        payeeId: payee.id,
        payeeName: payee.name,
        amount,
      });
    }
    return { payee, account };
  }

  test('opens from the payees list when a row is clicked', async ({
    authedPage: page,
    api,
  }) => {
    const { payee } = await seedPayeeWithHistory(api);

    await page.goto('/payees');
    await page.locator('tr', { hasText: payee.name }).click();

    await expect(page).toHaveURL(new RegExp(`/payees/${payee.id}$`));
    await expect(page.getByRole('heading', { name: payee.name })).toBeVisible();
  });

  test('shows the summary cards and overview panels', async ({
    authedPage: page,
    api,
  }) => {
    const { payee, account } = await seedPayeeWithHistory(api);

    await page.goto(`/payees/${payee.id}`);

    await expect(page.getByRole('heading', { name: payee.name })).toBeVisible();
    await expect(page.getByText('Spent This Year')).toBeVisible();
    await expect(page.getByText('Transactions', { exact: true }).first()).toBeVisible();
    // The per-account breakdown comes from the detail aggregate, so the
    // account the transactions were entered in has to appear by name.
    await expect(page.getByText('Paid From Accounts')).toBeVisible();
    await expect(page.getByText(account.name).first()).toBeVisible();
  });

  test('switches to the Transactions tab and lists the rows', async ({
    authedPage: page,
    api,
  }) => {
    const { payee, account } = await seedPayeeWithHistory(api);

    await page.goto(`/payees/${payee.id}`);
    await page.getByRole('tab', { name: 'Transactions' }).click();

    // Scoped to the panel: "Transactions" is also a tab label and a summary
    // card, and the Overview panel stays mounted (hidden) behind this one.
    const panel = page.getByRole('tabpanel', { name: 'Transactions' });
    // The heading carries the payee's full count -- the tab lists every
    // transaction, not a recent handful -- and the seed made three.
    await expect(panel.getByText('Transactions (3)')).toBeVisible();
    await expect(
      panel.getByRole('button', { name: 'Open in the register' }),
    ).toBeVisible();
    await expect(panel.getByText(account.name).first()).toBeVisible();
  });

  test('opens directly on a tab named by the query string', async ({
    authedPage: page,
    api,
  }) => {
    const { payee } = await seedPayeeWithHistory(api);

    await page.goto(`/payees/${payee.id}?tab=aliases`);

    await expect(
      page.getByRole('tab', { name: 'Aliases', selected: true }),
    ).toBeVisible();
  });

  test('links out to the filtered register', async ({ authedPage: page, api }) => {
    const { payee } = await seedPayeeWithHistory(api);

    await page.goto(`/payees/${payee.id}`);
    await page.getByRole('button', { name: 'View Transactions' }).click();

    await expect(page).toHaveURL(new RegExp(`/transactions\\?payeeId=${payee.id}`));
  });

  test('edits the payee from the detail page and persists the change', async ({
    authedPage: page,
    api,
  }) => {
    const { payee } = await seedPayeeWithHistory(api);
    const newName = `Renamed ${uniqueId()}`;

    await page.goto(`/payees/${payee.id}`);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();

    const dialog = page.getByRole('dialog');
    await dialog.getByLabel(/payee name/i).fill(newName);
    await dialog.getByRole('button', { name: /update payee/i }).click();

    await expect(page.getByRole('heading', { name: newName })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: newName })).toBeVisible();
  });

  test('deactivates the payee and then reactivates it', async ({
    authedPage: page,
    api,
  }) => {
    const { payee } = await seedPayeeWithHistory(api);

    await page.goto(`/payees/${payee.id}`);
    await page.getByRole('button', { name: 'Deactivate' }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Deactivate', exact: true })
      .click();

    await expect(page.getByText('Inactive').first()).toBeVisible();

    await page.getByRole('button', { name: 'Reactivate' }).click();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: /reactivate/i })
      .click();

    await expect(page.getByRole('button', { name: 'Deactivate' })).toBeVisible();
  });

  test('shows the error panel for an unknown payee id', async ({
    authedPage: page,
  }) => {
    // A well-formed uuid that belongs to nobody: the route resolves, the
    // aggregate 404s, and the page has to say so rather than render blank.
    await page.goto('/payees/00000000-0000-4000-8000-000000000000');

    // Scoped to the page's <main>: Next's route announcer is a second
    // `role="alert"` on every hydrated page, so a page-wide alert locator is
    // ambiguous and only ever passed by polling before the panel rendered.
    await expect(page.getByRole('main').getByRole('alert')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Back to Payees' })).toBeVisible();
  });
});
