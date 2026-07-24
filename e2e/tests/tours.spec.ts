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

    // Advance through the passive steps until the interactive
    // "Record a transaction" step (the engine navigates between screens).
    const next = page.getByRole('button', { name: 'Next', exact: true });
    for (let i = 0; i < 6; i++) {
      if (await page.getByText('Record a transaction').isVisible()) break;
      await next.click();
      await page.waitForTimeout(500);
    }
    await expect(page.getByText('Record a transaction')).toBeVisible();

    // Interactive: clicking the highlighted New Transaction button opens the
    // form, and the tour auto-advances to the currency-field step.
    await page.getByRole('button', { name: '+ New Transaction' }).click();
    await expect(page.getByText('Foreign currencies')).toBeVisible();

    // Passive next -> the centered "close the form" step.
    await next.click();
    await expect(page.getByText('Close the form to continue')).toBeVisible();

    // Closing the form fires the disappear-advance to the budgets step.
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByText('Plan with budgets')).toBeVisible();

    // Budgets -> reports -> finish.
    await next.click();
    await expect(page.getByText('Understand your money')).toBeVisible();
    await next.click();
    await expect(page.getByText("You're all set")).toBeVisible();

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
