import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures';
import { createAccount } from '../helpers/factories';
import { uniqueId } from '../helpers/api';
import { syntheticDocumentPng } from '../helpers/document-fixture';

/**
 * The Web Share Target, end to end.
 *
 * This is the only place the share path runs the way a user runs it: a real
 * service worker registered from a real page, a real multipart POST navigation,
 * and the real Cache API behind the stash. The unit suites drive sw.js in a
 * sandbox with every one of those stubbed, so a worker that never took control,
 * a stash key the window reads differently from the way the worker wrote it, or
 * a redirect the browser declines to follow would pass all of them and fail
 * here.
 *
 * The OS share sheet itself cannot be scripted. What the OS sends is a
 * multipart POST *navigation* to the manifest's action, and that is exactly what
 * a submitted form produces, so the test builds one and submits it.
 */
// A share target needs a controlling service worker, which Firefox does not
// offer this feature through at all, so the firefox project leaves this out
// (`@chromium-only`, playwright.config.ts): the feature is progressive
// enhancement, and the picker flows other specs cover are what a browser
// without it keeps.
test.describe('Web Share Target', { tag: '@chromium-only' }, () => {
  // Every other spec blocks service workers (playwright.config.ts); this one
  // is about the worker.
  test.use({ serviceWorkers: 'allow' });


  /** Wait until sw.js is not merely registered but actually controlling. */
  async function waitForServiceWorker(page: Page) {
    await page.waitForFunction(
      () => navigator.serviceWorker?.controller != null,
      undefined,
      { timeout: 60000 },
    );
  }

  /**
   * Share files into the app the way the OS does, and wait for the worker's
   * redirect to land on the review screen.
   */
  async function shareFiles(
    page: Page,
    files: { name: string; mimeType: string; buffer: Buffer }[],
  ) {
    const formId = `share-probe-${uniqueId()}`;
    await page.evaluate((id) => {
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = '/share-target';
      form.enctype = 'multipart/form-data';
      form.id = id;
      const input = document.createElement('input');
      input.type = 'file';
      input.name = 'files';
      input.id = `${id}-file`;
      input.multiple = true;
      form.appendChild(input);
      document.body.appendChild(form);
    }, formId);

    await page.setInputFiles(`#${formId}-file`, files);

    await Promise.all([
      page.waitForURL(/\/share\?id=/, { timeout: 30000 }),
      page.evaluate((id) => {
        (document.getElementById(id) as HTMLFormElement).submit();
      }, formId),
    ]);
  }

  test('a shared statement reaches the import wizard and imports nothing on its own', async ({
    authedPage: page,
    api,
  }) => {
    const account = await createAccount(api);

    await page.goto('/dashboard');
    await waitForServiceWorker(page);

    await shareFiles(page, [
      {
        name: 'statement.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from(
          'Date,Amount,Payee\n2026-01-15,-24.99,Coffee Shop\n2026-01-16,-13.50,Bakery\n',
        ),
      },
    ]);

    // The review screen names the file and offers the one destination a
    // statement has.
    await expect(page.getByText('statement.csv')).toBeVisible({ timeout: 15000 });
    const importButton = page.getByRole('button', {
      name: /import as a statement/i,
    });
    await expect(importButton).toBeVisible();
    await expect(
      page.getByRole('button', { name: /attach to a new transaction/i }),
    ).toHaveCount(0);
    // This account has no AI provider, so the assistant is not a destination:
    // a button whose one outcome is "configure a provider first" costs a press
    // to learn nothing.
    await expect(
      page.getByRole('button', { name: /send to ai assistant/i }),
    ).toHaveCount(0);

    // Landing here has written nothing.
    const before = await api.get<{ data: unknown[] }>(
      `/transactions?accountId=${account.id}&limit=50`,
    );
    expect(before.data).toHaveLength(0);

    await importButton.click();

    // The wizard opens on its own mapping step: the files are handed over, the
    // import itself is still ahead of the user. Named exactly, so this cannot
    // pass on some other piece of copy that happens to say "column".
    await page.waitForURL(/\/import/, { timeout: 30000 });
    await expect(
      page.getByText('CSV Column Mapping', { exact: false }),
    ).toBeVisible({ timeout: 30000 });

    // Still nothing imported: reaching the wizard is not importing.
    const after = await api.get<{ data: unknown[] }>(
      `/transactions?accountId=${account.id}&limit=50`,
    );
    expect(after.data).toHaveLength(0);
  });

  test('a shared receipt attaches only when the transaction is saved', async ({
    authedPage: page,
    api,
  }) => {
    const account = await createAccount(api);

    await page.goto('/dashboard');
    await waitForServiceWorker(page);

    await shareFiles(page, [
      {
        name: 'receipt.png',
        mimeType: 'image/png',
        buffer: syntheticDocumentPng(),
      },
    ]);

    await expect(page.getByText('receipt.png')).toBeVisible({ timeout: 15000 });
    const attachButton = page.getByRole('button', {
      name: /attach to a new transaction/i,
    });
    await expect(attachButton).toBeVisible();
    await expect(
      page.getByRole('button', { name: /import as a statement/i }),
    ).toHaveCount(0);

    await attachButton.click();

    // The form opens with the shared file already staged.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 15000 });
    await expect(dialog.getByText('receipt.png')).toBeVisible();

    // Nothing is stored yet.
    const before = await api.get<{ data: unknown[] }>(
      `/transactions?accountId=${account.id}&limit=50`,
    );
    expect(before.data).toHaveLength(0);

    // A share names no account, so the form opens without one: picking it is
    // part of the review, which is the point. Filled the same way
    // transactions.spec.ts fills this form.
    await dialog.getByLabel(/^account$/i).selectOption({ value: account.id });
    await dialog.getByLabel(/amount/i).first().fill('24.99');

    await dialog
      .getByRole('button', { name: /create transaction/i })
      .click();

    await expect(dialog).toBeHidden({ timeout: 30000 });

    // The transaction exists, and the shared file arrived on it.
    const created = await api.get<{ data: { id: string }[] }>(
      `/transactions?accountId=${account.id}&limit=50`,
    );
    expect(created.data.length).toBeGreaterThan(0);
    await expect(async () => {
      const attachments = await api.get<{ filename: string }[]>(
        `/transactions/${created.data[0].id}/attachments`,
      );
      expect(attachments.map((a) => a.filename)).toContain('receipt.png');
    }).toPass({ timeout: 20000 });
  });

  test('a share mixing receipts and statements offers neither destination', async ({
    authedPage: page,
  }) => {
    await page.goto('/dashboard');
    await waitForServiceWorker(page);

    await shareFiles(page, [
      {
        name: 'receipt.png',
        mimeType: 'image/png',
        buffer: syntheticDocumentPng(),
      },
      {
        name: 'statement.csv',
        mimeType: 'text/csv',
        buffer: Buffer.from('Date,Amount\n2026-01-15,-1.00\n'),
      },
    ]);

    await expect(
      page.getByText(/receipts and statements need separate shares/i),
    ).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByRole('button', { name: /attach to a new transaction/i }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: /import as a statement/i }),
    ).toHaveCount(0);
  });

  test('a file Monize cannot use is listed with its reason, not dropped', async ({
    authedPage: page,
  }) => {
    await page.goto('/dashboard');
    await waitForServiceWorker(page);

    await shareFiles(page, [
      {
        name: 'notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('not a statement'),
      },
    ]);

    await expect(page.getByText('notes.txt')).toBeVisible({ timeout: 15000 });
    await expect(
      page.getByText(/cannot use this kind of file/i),
    ).toBeVisible();
    await expect(
      page.getByText(/could not use any of these files/i),
    ).toBeVisible();
  });

  test('discarding a share removes it, and the review screen forgets it', async ({
    authedPage: page,
  }) => {
    await page.goto('/dashboard');
    await waitForServiceWorker(page);

    await shareFiles(page, [
      {
        name: 'receipt.png',
        mimeType: 'image/png',
        buffer: syntheticDocumentPng(),
      },
    ]);

    const shareUrl = page.url();
    await expect(page.getByText('receipt.png')).toBeVisible({ timeout: 15000 });

    await page.getByRole('button', { name: /^discard$/i }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: /^discard$/i }).click();

    // The screen leaves for Transactions once the bundle is gone; waiting for
    // that is what makes the re-read below a read of the finished state rather
    // than a race with the delete.
    await page.waitForURL(/\/transactions/, { timeout: 30000 });

    // Coming back to the same id finds nothing rather than the same files.
    await page.goto(shareUrl);
    await expect(page.getByText(/nothing here to review/i)).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText('receipt.png')).toHaveCount(0);
  });
});
