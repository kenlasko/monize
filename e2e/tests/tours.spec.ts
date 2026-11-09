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
    // Seed an account: the New Transaction form needs one to work with, and the
    // account-detail step needs a row whose Details action opens a detail page.
    const accountName = `Tour Chequing ${uniqueId()}`;
    await createAccount(api, { name: accountName, accountType: 'CHEQUING' });

    await page.goto('/dashboard');

    // Start from the Getting Started card.
    await page.getByRole('button', { name: 'Take the tour' }).click();
    await expect(page.getByText('Welcome to Monize')).toBeVisible();

    const next = page.getByRole('button', { name: 'Next', exact: true });
    // Click Next until the given step copy is on screen (the engine navigates
    // between screens as it goes).
    const advanceUntil = async (text: string) => {
      for (let i = 0; i < 10; i++) {
        // Wait for the step to render before deciding: `isVisible()` does not
        // wait, and the last step has no Next (its button is Done), so a Next
        // clicked before that step's copy is on screen waits for a button
        // that never comes.
        await expect(page.getByText(text).or(next).first()).toBeVisible();
        if (await page.getByText(text).isVisible()) return;
        await next.click();
        await page.waitForTimeout(500);
      }
      await expect(page.getByText(text)).toBeVisible();
    };

    // Passive steps: dashboard -> Tools -> Accounts, up to the interactive
    // "open an account's Details page" step.
    await advanceUntil("Open an account's detailed view");

    // Interactive: opening any account's Details page advances the tour on the
    // route change -- there is no per-row anchor to click, by design. The
    // seeded account is a CHEQUING one, so it lands on the banking detail view;
    // the step teaches the navigation, not one account type.
    //
    // This click is also the guard on where the coach mark parks: the default
    // bottom-right corner sits on the sticky row actions, and Playwright fails
    // it as "subtree intercepts pointer events" rather than letting a tour ship
    // with its card over the button its own copy names.
    await page
      .locator('tr', { hasText: accountName })
      .getByRole('button', { name: 'Details', exact: true })
      .click();
    await expect(page).toHaveURL(/\/accounts\/[0-9a-f-]{36}/);
    await expect(page.getByText('A view built for this account')).toBeVisible();

    // Transactions -> the interactive "Record a transaction" step.
    await advanceUntil('Record a transaction');

    // Interactive: clicking the highlighted New Transaction button opens the
    // form, and the tour auto-advances into the in-form steps.
    await page.getByRole('button', { name: '+ New Transaction' }).click();
    await expect(page.getByText('Payee and category')).toBeVisible();

    // In-form passive steps (fields -> splits -> currency) up to the centered
    // "close the form" step.
    await advanceUntil('Close the form to continue');

    // Closing the form fires the disappear-advance to the next step.
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByText('Bills & Deposits')).toBeVisible();

    // Bills -> Investments -> Budgets -> Reports -> finish.
    await advanceUntil("You're all set");

    // Done completes the tour. The save has to finish before the reload below,
    // which would otherwise cancel it.
    const saved = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname.endsWith('/updates/tours/progress') &&
        r.ok(),
    );
    await page.getByRole('button', { name: 'Done', exact: true }).click();
    await saved;
    await expect(page.getByText("You're all set")).toBeHidden();

    // Persistence round-trip: the completion is stored server-side, so the CTA
    // now offers to retake the tour after a full reload.
    await page.goto('/dashboard');
    await expect(
      page.getByRole('button', { name: 'Retake the tour' }),
    ).toBeVisible();
  });
});
