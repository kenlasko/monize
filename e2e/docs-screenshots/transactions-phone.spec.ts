import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { apiFor, waitForReady } from "../readme/session";
import { loadIds, type Ids } from "../readme/ids";
import { docShot, openDocsSession } from "./capture";

// website/docs/transactions.md: on a phone, the register narrowed to one
// account hands the header "Transactions - <account>" and the account menu
// once the page title scrolls away. Nothing is saved.

let context: BrowserContext;
let page: Page;
let ids: Ids;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  context = await openDocsSession(browser, "phone");
  await context.addInitScript(() => {
    for (const key of Object.keys(window.localStorage)) {
      if (
        key.startsWith("transactions.") ||
        key.startsWith("monize-transactions-")
      )
        window.localStorage.removeItem(key);
    }
  });
  page = await context.newPage();
  await page.goto("/dashboard");
  ids = await loadIds(apiFor(page));
});

test.beforeEach(() => {
  test.setTimeout(300_000);
});

test.afterAll(async () => {
  await context.close();
});

test("transactions-phone-header", async () => {
  await expect(async () => {
    await page.goto(`/transactions?accountId=${ids.chequing}`);
    await expect(page.getByText("Current Balance").first()).toBeVisible({
      timeout: 30_000,
    });
  }).toPass({ timeout: 120_000 });
  await expect(page.locator(".animate-spin, .animate-pulse")).toHaveCount(0, {
    timeout: 90_000,
  });
  await waitForReady(page);

  // Scroll the page title up behind the header.
  const header = page.locator("header").first();
  const collapsed = header.getByTestId("collapsed-header-title");
  await expect(async () => {
    await page.evaluate(() => window.scrollTo(0, 400));
    await expect(collapsed).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await expect(collapsed).toContainText("Transactions");

  await header
    .getByRole("button", { name: "Switch to another account" })
    .click();
  await expect(page.getByRole("menu")).toBeVisible();
  await waitForReady(page);
  await docShot(page, "transactions-phone-header");
  await page.keyboard.press("Escape");
});
