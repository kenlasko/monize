import { test, expect } from '../fixtures';
import { createAccount } from '../helpers/factories';
import { uniqueId } from '../helpers/api';

// Happy-path walkthrough of the introduction tour, driven entirely through the
// UI, ending with a persistence round-trip (reload -> the CTA offers a retake).
// A fresh user still sees the Getting Started card, which hosts the CTA.
test.describe('Guided tours', () => {
  test('runs the introduction tour and remembers completion', async ({
    authedPage: page,
    api,
  }) => {
    // Seed an account so the New Transaction form has something to work with.
    await createAccount(api, {
      name: `Tour Chequing ${uniqueId()}`,
      accountType: 'CHEQUING',
    });

    await page.goto('/dashboard');

    // Start from the Getting Started card.
    await page.getByRole('button', { name: 'Take the tour' }).click();
    await expect(page.getByText('Welcome to Monize')).toBeVisible();

    const next = page.getByRole('button', { name: 'Next', exact: true });
    // Click Next until the given step copy is on screen (the engine navigates
    // between screens as it goes).
    const advanceUntil = async (text: string) => {
      for (let i = 0; i < 10; i++) {
        if (await page.getByText(text).isVisible()) return;
        await next.click();
        await page.waitForTimeout(500);
      }
      await expect(page.getByText(text)).toBeVisible();
    };

    // Passive steps: dashboard -> Tools -> Accounts -> Transactions -> the
    // interactive "Record a transaction" step.
    await advanceUntil('Record a transaction');

    // Interactive: clicking the highlighted New Transaction button opens the
    // form, and the tour auto-advances into the in-form steps.
    await page.getByRole('button', { name: '+ New Transaction' }).click();
    await expect(page.getByText('Payee, category and amount')).toBeVisible();

    // In-form passive steps (fields -> splits -> currency) up to the centered
    // "close the form" step.
    await advanceUntil('Close the form to continue');

    // Closing the form fires the disappear-advance to the next step.
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByText('Bills & Deposits')).toBeVisible();

    // Bills -> Investments -> Budgets -> Reports -> finish.
    await advanceUntil("You're all set");

    // Done completes the tour.
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(page.getByText("You're all set")).toBeHidden();

    // Persistence round-trip: the completion is stored server-side, so the CTA
    // now offers to retake the tour after a full reload.
    await page.goto('/dashboard');
    await expect(
      page.getByRole('button', { name: 'Retake the tour' }),
    ).toBeVisible();
  });
});
