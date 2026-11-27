import path from 'node:path';
import { test, expect } from '../fixtures';
import type { Locator } from '@playwright/test';
import type { ApiClient } from '../helpers/api';
import { uniqueId } from '../helpers/api';
import {
  addBudgetCategory,
  createAccount,
  createBudget,
  createCategory,
  createSplitTransaction,
  createTag,
  createTransfer,
} from '../helpers/factories';

// A split line reads as the whole row it stands for (discussion #2403,
// docs/specs/split-line-equivalence.md). Every account is USD, so no FX is
// involved. Fixture: chequing A, savings B, a whole transfer of 100 from A to
// B, and one split on A of -160 = Groceries -60 + a transfer line of -100 to B,
// all dated in the current month.

/** Set E2E_SHOT_DIR to keep a picture of each asserted region (not committed). */
async function shoot(region: Locator, name: string) {
  const dir = process.env.E2E_SHOT_DIR;
  if (dir) await region.screenshot({ path: path.join(dir, `${name}.png`) });
}

async function seedTransfers(api: ApiClient) {
  const a = await createAccount(api, { name: `Chequing ${uniqueId()}`, openingBalance: 1000 });
  const b = await createAccount(api, {
    name: `Savings ${uniqueId()}`,
    accountType: 'SAVINGS',
    openingBalance: 1000,
  });
  const groceries = await createCategory(api, { name: `Groceries ${uniqueId()}` });
  await createTransfer(api, { fromAccountId: a.id, toAccountId: b.id, amount: 100 });
  return { a, b, groceries };
}

test.describe('Split lines read as their whole rows', () => {
  test('T1: Monthly Category Breakdown counts the split transfer line', async ({
    authedPage: page,
    api,
  }) => {
    test.setTimeout(180000);
    const { a, b, groceries } = await seedTransfers(api);
    await createSplitTransaction(api, {
      accountId: a.id,
      amount: -160,
      splits: [
        { amount: -60, categoryId: groceries.id },
        { amount: -100, transferAccountId: b.id },
      ],
    });

    await page.goto('/reports/monthly-category-breakdown');
    // The report leaves the running month out until asked.
    await page.getByRole('switch', { name: 'Include current month' }).click();

    const row = page.getByRole('row', { name: new RegExp(`From ${a.name}`) });
    await expect(row).toBeVisible();
    await shoot(page.getByRole('main'), 't1-monthly-category-breakdown');
    // Whole transfer 100 plus the split's transfer line 100.
    await expect(row).toContainText('$200.00');
  });

  test('T2: the register lists the split under the transfer filter and nets to zero', async ({
    authedPage: page,
    api,
  }) => {
    test.setTimeout(180000);
    const { a, b, groceries } = await seedTransfers(api);
    const split = await createSplitTransaction(api, {
      accountId: a.id,
      amount: -160,
      splits: [
        { amount: -60, categoryId: groceries.id },
        { amount: -100, transferAccountId: b.id },
      ],
    });

    await page.goto(`/transactions?accountIds=${a.id},${b.id}&categoryIds=transfer`);

    const rows = page.getByRole('row').filter({ hasText: /\$/ });
    await expect(rows.first()).toBeVisible();
    await shoot(page.getByRole('main'), 't2-register-transfer-filter');

    // Rows: whole out (-100), whole in (+100), the split's transfer line (-100)
    // and its counterpart (+100). The split is listed with its line's amount.
    const splitOut = page
      .getByRole('row')
      .filter({ hasText: split.payeeName ?? '' })
      .filter({ hasText: '-$100.00' });
    await expect.soft(splitOut).toHaveCount(1);
    // The newest row's balance is the net of every filtered row.
    await expect.soft(rows.first().getByRole('cell').nth(5)).toContainText('$0.00');
  });

  test('T3: a tag filter counts a line once however many selected tags match', async ({
    authedPage: page,
    api,
  }) => {
    test.setTimeout(180000);
    const { a, b, groceries } = await seedTransfers(api);
    // A second expense category, so Groceries alone is a real category filter.
    await createCategory(api, { name: `Dining ${uniqueId()}` });
    const t1 = await createTag(api, { name: `T1 ${uniqueId()}` });
    const t2 = await createTag(api, { name: `T2 ${uniqueId()}` });
    await createSplitTransaction(api, {
      accountId: a.id,
      amount: -160,
      tagIds: [t1.id],
      splits: [
        { amount: -60, categoryId: groceries.id, tagIds: [t1.id, t2.id] },
        { amount: -100, transferAccountId: b.id },
      ],
    });

    // The Groceries widget reads the same summary the register's tag filter
    // does; it opens when the register is filtered to one category (and, with
    // two accounts, no account widget takes its place).
    await page.goto(`/transactions?accountIds=${a.id},${b.id}&categoryIds=${groceries.id}&tagIds=${t1.id}`);

    const spent = page.getByText('Total Spent', { exact: true });
    await expect(spent).toBeVisible();
    await shoot(spent.locator('xpath=ancestor::div[2]'), 't3-tag-filter');
    await expect(spent.locator('xpath=following-sibling::p')).toHaveText('$60.00');
  });

  test('T4: Budget Health savings rate leaves a positive transfer line out of income', async ({
    authedPage: page,
    api,
  }) => {
    test.setTimeout(180000);
    const { a, b, groceries } = await seedTransfers(api);
    const salary = await createCategory(api, { name: `Salary ${uniqueId()}`, type: 'income' });
    // An expense line only: with no income line the income is read from the
    // month's positive non-transfer deposits.
    const budget = await createBudget(api, { name: `Savings ${uniqueId()}` });
    await addBudgetCategory(api, budget.id, { categoryId: groceries.id, amount: 500 });
    await createSplitTransaction(api, {
      accountId: a.id,
      amount: 600,
      splits: [
        { amount: 500, transferAccountId: b.id },
        { amount: 100, categoryId: salary.id },
      ],
    });

    await page.goto('/reports/savings-rate');

    const now = new Date();
    const month = `${String(now.getMonth() + 1).padStart(2, '0')}/${now.getFullYear()}`;
    const row = page.getByRole('row').filter({ hasText: month });
    await expect(row).toBeVisible();
    await shoot(page.getByRole('main'), 't4-savings-rate');
    // Cells: month, income, expenses, savings, rate.
    await expect(row.getByRole('cell').nth(1)).toContainText(/\$100(?!\d)/);
  });
});
