import { test, expect } from '../fixtures';
import { createAccount } from '../helpers/factories';
import { uniqueId } from '../helpers/api';

// Action history (audit + undo/redo). Mutating actions are recorded and
// surfaced in the header panel (data-testids: action-history-button/panel,
// undo-button, redo-button). List pages subscribe to the undo/redo signal via
// useOnUndoRedo, so they refresh automatically after an undo/redo.
test.describe('Action history (undo/redo)', () => {
  test('records an action, then undoes and redoes it', async ({
    authedPage: page,
    api,
  }) => {
    const name = `History Acct ${uniqueId()}`;
    await createAccount(api, { name });

    await page.goto('/accounts');
    await expect(page.locator('tr', { hasText: name })).toBeVisible();

    // The create is recorded; open the panel and find the entry.
    await page.getByTestId('action-history-button').click();
    const panel = page.getByTestId('action-history-panel');
    await expect(panel.getByText(name).first()).toBeVisible();

    // Undo reverses the create; the accounts list refreshes via the signal.
    await panel.getByTestId('undo-button').click();
    await expect(page.locator('tr', { hasText: name })).toHaveCount(0);

    // Redo re-applies it.
    await panel.getByTestId('redo-button').click();
    await expect(page.locator('tr', { hasText: name })).toBeVisible();
  });
});
