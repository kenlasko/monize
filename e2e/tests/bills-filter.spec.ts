import { test, expect } from '../fixtures';
import { createAccount } from '../helpers/factories';
import { ApiClient, uniqueId } from '../helpers/api';

// E2E coverage for the Bills & Deposits filter panel, driven through the UI.
// Each test gets a fresh user (see fixtures), so data is seeded per-test and
// needs no cleanup.
//
// Scope note: only the Name filter and the Clear flow are exercised here. The
// Account / Payee / Category filters are driven by the custom portal-rendered
// MultiSelect, which the existing E2E suite intentionally does not automate
// (see the combobox note in transactions.spec.ts). Those filters are covered
// by the unit + component tests (bills-filters.test.ts, BillsFilterPanel.test.tsx).

interface SeededSchedule {
  id: string;
  name: string;
}

function seedSchedule(
  api: ApiClient,
  data: { accountId: string; name: string; amount?: number },
): Promise<SeededSchedule> {
  return api.post<SeededSchedule>('/scheduled-transactions', {
    accountId: data.accountId,
    name: data.name,
    amount: data.amount ?? -100,
    currencyCode: 'USD',
    frequency: 'MONTHLY',
    nextDueDate: new Date().toISOString().slice(0, 10),
  });
}

test.describe('Bills & Deposits filtering', () => {
  test('filters the list by name', async ({ authedPage: page, api }) => {
    const account = await createAccount(api);
    const alpha = `Alpha Rent ${uniqueId()}`;
    const bravo = `Bravo Net ${uniqueId()}`;
    await seedSchedule(api, { accountId: account.id, name: alpha });
    await seedSchedule(api, { accountId: account.id, name: bravo });

    await page.goto('/bills');
    await expect(page.locator('tr', { hasText: alpha })).toBeVisible();
    await expect(page.locator('tr', { hasText: bravo })).toBeVisible();

    await page.getByRole('button', { name: /Filters/ }).click();
    await page.getByPlaceholder('Search by name...').fill('Alpha Rent');

    await expect(page.locator('tr', { hasText: alpha })).toBeVisible();
    await expect(page.locator('tr', { hasText: bravo })).toHaveCount(0);
  });

  test('clears the name filter to restore the full list', async ({ authedPage: page, api }) => {
    const account = await createAccount(api);
    const alpha = `Alpha Rent ${uniqueId()}`;
    const bravo = `Bravo Net ${uniqueId()}`;
    await seedSchedule(api, { accountId: account.id, name: alpha });
    await seedSchedule(api, { accountId: account.id, name: bravo });

    await page.goto('/bills');
    await page.getByRole('button', { name: /Filters/ }).click();
    await page.getByPlaceholder('Search by name...').fill('Alpha Rent');

    // One active filter group -> count badge of 1, and only Alpha remains.
    await expect(page.getByRole('button', { name: /Filters/ })).toContainText('1');
    await expect(page.locator('tr', { hasText: bravo })).toHaveCount(0);

    await page.getByText('Clear', { exact: true }).click();

    // Both rows return once filters are cleared.
    await expect(page.locator('tr', { hasText: alpha })).toBeVisible();
    await expect(page.locator('tr', { hasText: bravo })).toBeVisible();
  });
});
