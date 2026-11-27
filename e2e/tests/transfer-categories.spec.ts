import { test, expect } from '../fixtures';
import type { Page } from '@playwright/test';
import { rawApiRequest, uniqueId, type ApiClient } from '../helpers/api';
import {
  addBudgetCategory,
  createAccount,
  createBudget,
  createCategory,
  createSplitTransaction,
  createTransaction,
  createTransfer,
} from '../helpers/factories';

// Transfer categories (discussion #2387, docs/specs/transfer-categories.md): a
// third category type that goes only on a transfer. Fixtures are seeded through
// the API; each behaviour is asserted through the UI, and the persisted rows
// through the API where the screen does not show them. Every account is USD.

interface TransactionRead {
  id: string;
  categoryId: string | null;
  isSplit?: boolean;
  splits?: { id: string; categoryId: string | null; transferAccountId: string | null }[];
}

async function seedAccounts(api: ApiClient) {
  const checking = await createAccount(api, {
    name: `Chequing ${uniqueId()}`,
    openingBalance: 5000,
  });
  const savings = await createAccount(api, {
    name: `Savings ${uniqueId()}`,
    accountType: 'SAVINGS',
    openingBalance: 1000,
  });
  return { checking, savings };
}

async function openBreakdown(page: Page) {
  await page.goto('/reports/monthly-category-breakdown');
  // The report leaves the running month out until asked.
  await page.getByRole('switch', { name: 'Include current month' }).click();
}

test.describe('Transfer categories', () => {
  test('creates a Transfer category through the UI', async ({ authedPage: page }) => {
    const name = `Contributions ${uniqueId()}`;

    await page.goto('/categories');

    const dialog = page.getByRole('dialog');
    await expect(async () => {
      await page.getByRole('button', { name: /new category/i }).first().click();
      await expect(dialog).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 30000 });

    await dialog.getByLabel(/category name/i).fill(name);
    await dialog.getByLabel('Type').selectOption('transfer');
    await dialog.getByRole('button', { name: /create category/i }).click();

    const row = page.locator('tr', { hasText: name });
    await expect(row).toBeVisible();
    await expect(row).toContainText('Transfer');
    await page.reload();
    await expect(page.locator('tr', { hasText: name })).toContainText('Transfer');
  });

  test('a transfer holds a Transfer category on both legs; an ordinary row refuses it', async ({
    authedPage: page,
    api,
  }) => {
    const { checking, savings } = await seedAccounts(api);
    const category = await createCategory(api, {
      name: `Savings contributions ${uniqueId()}`,
      type: 'transfer',
    });
    const transfer = await createTransfer(api, {
      fromAccountId: checking.id,
      toAccountId: savings.id,
      amount: 100,
    });

    // Categorize the outgoing leg; the incoming leg follows (one category per
    // transfer).
    await api.patch(`/transactions/${transfer.fromTransaction.id}`, {
      categoryId: category.id,
    });
    const out = await api.get<TransactionRead>(`/transactions/${transfer.fromTransaction.id}`);
    const inc = await api.get<TransactionRead>(`/transactions/${transfer.toTransaction.id}`);
    expect(out.categoryId).toBe(category.id);
    expect(inc.categoryId).toBe(category.id);

    // An ordinary row takes only Income or Expense: refused, nothing written.
    const refused = await rawApiRequest(page.request, 'POST', '/transactions', {
      accountId: checking.id,
      amount: -20,
      payeeName: `Plain ${uniqueId()}`,
      transactionDate: new Date().toISOString().slice(0, 10),
      currencyCode: 'USD',
      categoryId: category.id,
    });
    expect(refused.status()).toBe(400);

    // Clearing it on the incoming leg clears the outgoing one too.
    await api.patch(`/transactions/${transfer.toTransaction.id}`, { categoryId: null });
    const cleared = await api.get<TransactionRead>(`/transactions/${transfer.fromTransaction.id}`);
    expect(cleared.categoryId).toBeNull();
  });

  test("a split's transfer line carries a Transfer category", async ({
    authedPage: page,
    api,
  }) => {
    const { checking, savings } = await seedAccounts(api);
    const transferCategory = await createCategory(api, {
      name: `Investing ${uniqueId()}`,
      type: 'transfer',
    });
    const fees = await createCategory(api, { name: `Bank fees ${uniqueId()}` });
    const split = await createSplitTransaction(api, {
      accountId: checking.id,
      amount: -105,
      payeeName: `Bank ${uniqueId()}`,
      splits: [
        { amount: -100, transferAccountId: savings.id, categoryId: transferCategory.id },
        { amount: -5, categoryId: fees.id },
      ],
    });

    const read = await api.get<TransactionRead>(`/transactions/${split.id}`);
    const transferLine = read.splits?.find((s) => s.transferAccountId === savings.id);
    expect(transferLine?.categoryId).toBe(transferCategory.id);

    // A category line refuses a Transfer category.
    const refused = await rawApiRequest(page.request, 'POST', '/transactions', {
      accountId: checking.id,
      amount: -30,
      payeeName: `Bad split ${uniqueId()}`,
      transactionDate: new Date().toISOString().slice(0, 10),
      currencyCode: 'USD',
      splits: [
        { amount: -10, categoryId: transferCategory.id },
        { amount: -20, categoryId: fees.id },
      ],
    });
    expect(refused.status()).toBe(400);

    // The register shows the line's category on the split.
    await page.goto('/transactions');
    await expect(page.locator('tr', { hasText: split.payeeName! }).first()).toBeVisible();
  });

  test('the Monthly Category Breakdown lists a categorized transfer under its category', async ({
    authedPage: page,
    api,
  }) => {
    test.setTimeout(180000);
    const { checking, savings } = await seedAccounts(api);
    const category = await createCategory(api, {
      name: `Rainy day ${uniqueId()}`,
      type: 'transfer',
    });
    await createTransfer(api, {
      fromAccountId: checking.id,
      toAccountId: savings.id,
      amount: 250,
      categoryId: category.id,
    });
    // A second, uncategorized transfer stays in its per-account row.
    await createTransfer(api, {
      fromAccountId: checking.id,
      toAccountId: savings.id,
      amount: 40,
    });

    await openBreakdown(page);

    const row = page.getByRole('row', { name: new RegExp(category.name) }).first();
    await expect(row).toBeVisible();
    await expect(row).toContainText('$250.00');
    // The uncategorized transfer is still under the account it left.
    await expect(
      page.getByRole('row', { name: new RegExp(`From ${checking.name}`) }),
    ).toBeVisible();
  });

  test('a budget line on a Transfer category counts the transfers that hold it', async ({
    authedPage: page,
    api,
  }) => {
    const { checking, savings } = await seedAccounts(api);
    const category = await createCategory(api, {
      name: `Emergency fund ${uniqueId()}`,
      type: 'transfer',
    });
    // Savings sits outside the budget, so money moved there leaves it and the
    // line reads the full amount (a transfer between two budget accounts nets
    // to zero on its line).
    const budget = await createBudget(api, {
      name: `Plan ${uniqueId()}`,
      config: { excludedAccountIds: [savings.id] },
    });
    await addBudgetCategory(api, budget.id, { categoryId: category.id, amount: 300 });
    await createTransfer(api, {
      fromAccountId: checking.id,
      toAccountId: savings.id,
      amount: 125,
      categoryId: category.id,
    });
    // Seed an ordinary expense so the budget has spending of its own.
    await createTransaction(api, { accountId: checking.id, amount: -10 });

    await page.goto(`/budgets/${budget.id}`);
    await expect(page.getByRole('heading', { name: budget.name })).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText(category.name).first()).toBeVisible();
    await expect(page.getByText(/\$300/).first()).toBeVisible();
    // The period summary is recomputed on load; poll until the actual shows.
    await expect(async () => {
      await page.reload();
      await expect(page.getByText(/\$125/).first()).toBeVisible({ timeout: 5000 });
    }).toPass({ timeout: 30000 });
  });
});
