import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { waitForReady } from "../readme/session";
import { docShot, openDocsSession } from "./capture";

// website/docs/currency-management.md. Dialogs are opened and closed; no
// currency is created or changed.

test.describe.configure({ timeout: 300_000 });

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  context = await openDocsSession(browser);
  page = await context.newPage();
});

test.afterAll(async () => {
  await context.close();
});

/** The Currencies page, once the table and its rates are in. */
async function openCurrencies(): Promise<void> {
  await page.goto("/currencies");
  await expect(
    page.getByRole("heading", { name: "Currencies", level: 1 }),
  ).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByRole("row", { name: /^USD US Dollar/ })).toBeVisible({
    timeout: 30_000,
  });
  await waitForReady(page);
}

test("currencies-page", async () => {
  await openCurrencies();
  await docShot(page, "currencies-page");
});

test("currency-form", async () => {
  await openCurrencies();
  await page.getByRole("button", { name: "+ New Currency" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "New Currency" }),
  ).toBeVisible();
  await docShot(page, "currency-form", dialog);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});

test("currency-rate-history", async () => {
  await openCurrencies();
  await page
    .getByRole("row", { name: /^USD US Dollar/ })
    .getByRole("button", { name: "Rate history" })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("heading", { name: "USD" })).toBeVisible();
  await expect(dialog.getByText(/Stored history/)).toBeVisible({
    timeout: 30_000,
  });
  await waitForReady(page);
  await docShot(page, "currency-rate-history", dialog);
  await dialog.getByRole("button", { name: "Close" }).last().click();
  await expect(dialog).toHaveCount(0);
});
