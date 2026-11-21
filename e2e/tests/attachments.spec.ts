import { test, expect } from '../fixtures';
import { createAccount, createTransaction } from '../helpers/factories';
import { uniqueId } from '../helpers/api';
import { syntheticDocumentPng } from '../helpers/document-fixture';
import { minimalPdf } from '../helpers/pdf-fixture';

/**
 * Attachments, including the document scanner.
 *
 * This is the only place the scanner runs the way a user runs it: a real
 * browser, the real WebAssembly build, a real worker and the real CSP. The unit
 * suites load the engine through Node, which cannot exercise any of those --
 * so a `wasm-unsafe-eval` that never reached the header, a worker the bundler
 * emitted as a module, or a vendored file that was not copied would all pass
 * every other suite and fail here.
 */
test.describe('Transaction attachments', () => {
  /**
   * The scanner is a touch-device control (`isTouchDevice`, a coarse-pointer
   * query): a desktop has only Add attachment, which opens the same file
   * picker. These runs are desktop browsers, so the page is told it points
   * with a finger. An init script rather than Playwright's `isMobile`, which
   * Firefox does not support; it must run before the page loads.
   */
  async function asTouchDevice(page: import('@playwright/test').Page) {
    await page.addInitScript(() => {
      const original = window.matchMedia.bind(window);
      window.matchMedia = (query: string) =>
        query.replace(/\s+/g, '') === '(pointer:coarse)'
          ? ({
              matches: true,
              media: query,
              onchange: null,
              addEventListener: () => {},
              removeEventListener: () => {},
              addListener: () => {},
              removeListener: () => {},
              dispatchEvent: () => false,
            } as MediaQueryList)
          : original(query);
    });
  }

  /** Open the edit dialog for a transaction by its payee name. */
  async function openTransaction(page: import('@playwright/test').Page, payeeName: string) {
    const dialog = page.getByRole('dialog');
    // The list is client-rendered, so a click landing before the row's handler
    // hydrates is a no-op -- retry rather than clicking into the void.
    await expect(async () => {
      await page.locator('tr', { hasText: payeeName }).first().click();
      await expect(dialog).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 30000 });
    return dialog;
  }

  test('uploads, lists and deletes a plain attachment', async ({
    authedPage: page,
    api,
  }) => {
    const account = await createAccount(api);
    const payeeName = `Attach Plain ${uniqueId()}`;
    await createTransaction(api, { accountId: account.id, payeeName });

    await page.goto('/transactions');
    const dialog = await openTransaction(page, payeeName);

    await dialog.getByLabel('Add attachment').setInputFiles({
      name: 'note.png',
      mimeType: 'image/png',
      buffer: syntheticDocumentPng(),
    });

    const row = dialog.locator('li', { hasText: 'note.png' });
    await expect(row).toBeVisible({ timeout: 15000 });

    // Clicking the row previews rather than downloads.
    await row.getByRole('button', { name: 'Preview note.png' }).click();
    const preview = page.getByRole('dialog', { name: 'note.png' });
    await expect(preview).toBeVisible();
    await expect(preview.getByRole('img', { name: 'note.png' })).toBeVisible({
      timeout: 15000,
    });
    // A plain upload is stored as it was given: no original to switch to.
    await expect(preview.getByRole('button', { name: 'Original' })).toHaveCount(0);
    // Download is still offered, from the preview.
    const downloadHref = await preview
      .getByRole('link', { name: 'Download' })
      .getAttribute('href');
    expect(downloadHref).toBeTruthy();
    expect((await page.request.get(downloadHref!)).status()).toBe(200);
    await preview.getByRole('button', { name: 'Close' }).last().click();
    await expect(preview).toHaveCount(0);

    await row.getByRole('button', { name: 'Delete' }).click();
    await page
      .getByRole('button', { name: 'Delete' })
      .last()
      .click();
    await expect(row).toHaveCount(0, { timeout: 15000 });
  });

  test('scans a document and keeps the photo it came from', async ({
    authedPage: page,
    api,
  }) => {
    const account = await createAccount(api);
    const payeeName = `Attach Scan ${uniqueId()}`;
    await createTransaction(api, { accountId: account.id, payeeName });

    await asTouchDevice(page);
    await page.goto('/transactions');
    const dialog = await openTransaction(page, payeeName);

    await dialog.getByLabel('Scan document').setInputFiles({
      name: 'receipt.png',
      mimeType: 'image/png',
      buffer: syntheticDocumentPng(),
    });

    // The engine is several megabytes and compiles WebAssembly on first use,
    // so this is the one step that legitimately takes a while.
    const useEnhanced = page.getByRole('button', { name: 'Use enhanced' });
    await expect(useEnhanced).toBeEnabled({ timeout: 120000 });

    // The fixture is a clean, fully framed page: the scanner should find it.
    await expect(
      page.getByText(/No document edges were found/i),
    ).toHaveCount(0);

    await useEnhanced.click();

    // One row, not two: a scan pair is one attachment.
    const scanRow = dialog.locator('li', { hasText: 'receipt-scan.jpg' });
    await expect(scanRow).toBeVisible({ timeout: 30000 });
    await expect(dialog.locator('li', { hasText: 'receipt.png' })).toHaveCount(
      0,
    );

    // The photo is still reachable: the preview switches between the two,
    // and Download follows whichever is on screen.
    await scanRow.getByRole('button', { name: 'Preview receipt-scan.jpg' }).click();
    const preview = page.getByRole('dialog', { name: 'receipt-scan.jpg' });
    await expect(preview).toBeVisible();
    const download = preview.getByRole('link', { name: 'Download' });
    const scanHref = await download.getAttribute('href');

    const original = preview.getByRole('button', { name: 'Original' });
    await expect(original).toBeVisible();
    await original.click();
    await expect(original).toHaveAttribute('aria-pressed', 'true');
    const originalHref = await download.getAttribute('href');
    expect(scanHref).toBeTruthy();
    expect(originalHref).toBeTruthy();
    expect(originalHref).not.toBe(scanHref);
    await preview.getByRole('button', { name: 'Close' }).last().click();
    await expect(preview).toHaveCount(0);

    const scanResponse = await page.request.get(scanHref!);
    const originalResponse = await page.request.get(originalHref!);
    expect(scanResponse.status()).toBe(200);
    expect(originalResponse.status()).toBe(200);
    // The enhanced image is a re-encoded JPEG; the original is the PNG that
    // was handed over. Identical bodies would mean one of them was not stored.
    expect((await scanResponse.body()).length).toBeGreaterThan(0);
    expect((await originalResponse.body()).length).toBeGreaterThan(0);
    expect((await scanResponse.body()).equals(await originalResponse.body())).toBe(
      false,
    );

    // Deleting what the user sees takes the original with it.
    await scanRow.getByRole('button', { name: 'Delete' }).click();
    await page.getByRole('button', { name: 'Delete' }).last().click();
    await expect(scanRow).toHaveCount(0, { timeout: 15000 });

    await expect
      .poll(async () => (await page.request.get(originalHref!)).status(), {
        timeout: 15000,
      })
      .toBe(404);
  });

  test('keeps only the photo when the scan is declined', async ({
    authedPage: page,
    api,
  }) => {
    const account = await createAccount(api);
    const payeeName = `Attach Decline ${uniqueId()}`;
    await createTransaction(api, { accountId: account.id, payeeName });

    await asTouchDevice(page);
    await page.goto('/transactions');
    const dialog = await openTransaction(page, payeeName);

    await dialog.getByLabel('Scan document').setInputFiles({
      name: 'receipt.png',
      mimeType: 'image/png',
      buffer: syntheticDocumentPng(),
    });

    const keepOriginal = page.getByRole('button', {
      name: 'Keep original only',
    });
    await expect(keepOriginal).toBeVisible({ timeout: 120000 });
    await keepOriginal.click();

    // The photo is stored under its own name, with nothing behind it.
    const row = dialog.locator('li', { hasText: 'receipt.png' });
    await expect(row).toBeVisible({ timeout: 30000 });
    await row.getByRole('button', { name: 'Preview receipt.png' }).click();
    const preview = page.getByRole('dialog', { name: 'receipt.png' });
    await expect(preview).toBeVisible();
    await expect(preview.getByRole('button', { name: 'Original' })).toHaveCount(0);
  });

  test('previews a PDF in the app', async ({ authedPage: page, api }) => {
    const account = await createAccount(api);
    const payeeName = `Attach Pdf ${uniqueId()}`;
    await createTransaction(api, { accountId: account.id, payeeName });

    await page.goto('/transactions');
    const dialog = await openTransaction(page, payeeName);

    await dialog.getByLabel('Add attachment').setInputFiles({
      name: 'invoice.pdf',
      mimeType: 'application/pdf',
      buffer: minimalPdf(),
    });

    const row = dialog.locator('li', { hasText: 'invoice.pdf' });
    await expect(row).toBeVisible({ timeout: 15000 });
    await row.getByRole('button', { name: 'Preview invoice.pdf' }).click();
    const preview = page.getByRole('dialog', { name: 'invoice.pdf' });
    await expect(preview).toBeVisible();

    // This is the only place the vendored worker, its module MIME type and
    // the page's CSP are exercised: the unit suites mock the engine away. A
    // drawn page is a canvas with a real size; a failed engine is an alert.
    const firstPage = preview.getByRole('img', { name: 'Page 1 of 1' });
    await expect(firstPage).toBeVisible({ timeout: 60000 });
    await expect
      .poll(async () => firstPage.evaluate((el) => (el as HTMLCanvasElement).height), {
        timeout: 60000,
      })
      .toBeGreaterThan(0);
    await expect(preview.getByRole('alert')).toHaveCount(0);

    const downloadHref = await preview
      .getByRole('link', { name: 'Download' })
      .getAttribute('href');
    const response = await page.request.get(downloadHref!);
    expect(response.status()).toBe(200);
    expect(response.headers()['content-type']).toContain('application/pdf');
  });
});
