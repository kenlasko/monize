import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { apiFor, waitForReady } from "../readme/session";
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
  const btc = page.getByRole("row", { name: /BTC-CAD/ }).first();
  await expect(btc).toBeVisible();
  // The coin's eight decimal places, in the Decimals column.
  await expect(btc.getByRole("cell", { name: "8", exact: true })).toBeVisible();
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

/**
 * Whether the stack's backend can price `symbol` on Yahoo, asked the way the
 * form's Verify asks. The capture stack may have no route to Yahoo; the
 * picture then shows the symbol typed but not verified.
 */
async function yahooPrices(symbol: string): Promise<boolean> {
  try {
    const found = await apiFor(page).get<{
      securityType: string | null;
    } | null>(
      `/securities/lookup?q=${encodeURIComponent(symbol)}&provider=yahoo`,
    );
    return found?.securityType === "CRYPTO";
  } catch {
    return false;
  }
}

test("currency-form-crypto", async () => {
  await openCurrencies();
  await page.getByRole("button", { name: "+ New Currency" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "New Currency" }),
  ).toBeVisible();
  await dialog.getByLabel("Currency Code").fill("ETH");
  await dialog
    .getByRole("group", { name: "Kind" })
    .getByRole("button", { name: "Cryptocurrency", exact: true })
    .click();
  const priceSymbol = dialog.getByLabel("Price Symbol (optional)");
  await priceSymbol.fill("ETH-CAD");
  if (await yahooPrices("ETH-CAD")) {
    await dialog.getByRole("button", { name: "Verify", exact: true }).click();
    await expect(dialog.getByText("Priced in CAD")).toBeVisible({
      timeout: 60_000,
    });
  }
  await dialog.getByLabel("Name", { exact: true }).fill("Ether");
  await dialog.getByLabel("Currency Code").click();
  await waitForReady(page);
  await docShot(page, "currency-form-crypto", dialog);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  const discard = page.getByRole("button", { name: "Discard", exact: true });
  await expect(async () => {
    if ((await discard.count()) > 0) await discard.click({ timeout: 5_000 });
    await expect(dialog).toHaveCount(0, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
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
