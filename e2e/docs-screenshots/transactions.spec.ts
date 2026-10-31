import {
  test,
  expect,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { apiFor, scrollUnderHeader, waitForReady } from "../readme/session";
import { loadIds, type Ids } from "../readme/ids";
import { showcaseMonth } from "../readme/settings";
import { docShot, openDocsSession } from "./capture";

// website/docs/transactions.md: the register in its views, the filter panel, a
// search, and the transaction form in each mode. Every form is left with
// Cancel (discarding), every menu with Escape; nothing is saved. Bulk mode only
// selects rows and opens the dialog.

let context: BrowserContext;
let page: Page;
let ids: Ids;

test.beforeAll(async ({ browser }) => {
  // Signing in loads the dashboard, which a busy development server can be slow to serve.
  test.setTimeout(300_000);
  context = await openDocsSession(browser);
  // The register remembers its filters, view and chart state in this
  // browser; every picture starts from none of them.
  await context.addInitScript(() => {
    for (const key of Object.keys(window.localStorage)) {
      if (key.startsWith("transactions.")) window.localStorage.removeItem(key);
    }
  });
  page = await context.newPage();
  await page.goto("/dashboard");
  ids = await loadIds(apiFor(page));
});

// A busy development server can take minutes over one picture.
test.beforeEach(() => {
  test.setTimeout(300_000);
});

test.afterAll(async () => {
  await context.close();
});

/**
 * Open `path` and wait for it to settle. Under load the app's start-up check
 * can give up before the server answers and show "Unable to connect"; the
 * page is then simply loaded again.
 */
/**
 * Nothing still loading. A busy development server can keep a spinner turning
 * for longer than the usual wait, so this one is generous.
 */
async function settled(): Promise<void> {
  await expect(page.locator(".animate-spin, .animate-pulse")).toHaveCount(0, {
    timeout: 90_000,
  });
  await waitForReady(page);
}

async function openPage(path: string): Promise<void> {
  await expect(async () => {
    await page.goto(path);
    await expect(page.getByRole("main").first()).toBeVisible({
      timeout: 30_000,
    });
  }).toPass({ timeout: 120_000 });
  await settled();
}

const chartDrawn = () =>
  expect(page.locator(".recharts-surface").first()).toBeVisible({
    timeout: 30_000,
  });

const scrollTo = (locator: Locator, gap = 16) =>
  scrollUnderHeader(page, locator, gap);

async function openRegister(query = ""): Promise<void> {
  await openPage(`/transactions${query}`);
  // The table, not the calendar the calendar picture leaves behind: the view
  // is remembered outside the register's own filter keys.
  const table = page.getByRole("button", { name: "Table", exact: true });
  await expect(table).toBeVisible({ timeout: 90_000 });
  if ((await table.getAttribute("aria-pressed")) !== "true")
    await table.click();
  await expect(page.getByText(/Showing 1 - \d+ of/).first()).toBeVisible({
    timeout: 90_000,
  });
  await settled();
}

/**
 * The New Transaction dialog. A click that lands before the page has
 * hydrated opens nothing, so the click is retried until the dialog is there.
 */
async function openNewTransaction(): Promise<Locator> {
  await openRegister();
  const dialog = page.getByRole("dialog", { name: "New Transaction" });
  await expect(async () => {
    if ((await dialog.count()) === 0) {
      await page.getByRole("button", { name: "+ New Transaction" }).click();
    }
    await expect(
      dialog.getByRole("button", { name: "Create Transaction" }),
    ).toBeVisible({
      timeout: 5_000,
    });
  }).toPass({ timeout: 60_000 });
  await settled();
  return dialog;
}

/** Leave a form unsaved: Cancel, and Discard if it asks. */
async function cancel(dialog: Locator): Promise<void> {
  const discard = page.getByRole("button", { name: "Discard", exact: true });
  await expect(async () => {
    if ((await discard.count()) > 0) {
      await discard.click({ timeout: 5_000 });
    } else if ((await dialog.count()) > 0) {
      await dialog
        .getByRole("button", { name: "Cancel", exact: true })
        .last()
        .click({ timeout: 5_000 });
    }
    await expect(dialog).toHaveCount(0, { timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

test("transactions-page", async () => {
  await openRegister();
  await expect(page.getByText("Coffee run").first()).toBeVisible();
  await chartDrawn();
  await page.evaluate(() => window.scrollTo(0, 0));
  await docShot(page, "transactions-page");
});

test("transactions-list", async () => {
  await openRegister();
  await expect(page.getByText("Coffee run").first()).toBeVisible();
  await chartDrawn();
  await scrollTo(page.getByText(/Showing 1 - \d+ of/).first());
  await docShot(page, "transactions-list");
});

test("transaction-filters", async () => {
  await openRegister();
  const panel = page
    .getByRole("textbox", { name: "Search" })
    .locator(
      'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " rounded-lg ")][1]',
    );
  await expect(panel.getByText("Time Period")).toBeVisible();
  await panel.scrollIntoViewIfNeeded();
  await docShot(page, "transaction-filters", panel);
});

test("transactions-search", async () => {
  await openRegister();
  await page
    .getByRole("textbox", { name: "Search" })
    .fill("payee:tim amount:<10");
  await expect(page.getByText("Searching:")).toBeVisible({ timeout: 30_000 });
  await expect(
    page.getByRole("row", { name: /Tim Hortons/ }).first(),
  ).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Search syntax" }).click();
  await expect(page.getByText("Payee contains costco")).toBeVisible();
  await settled();
  await scrollTo(page.getByRole("textbox", { name: "Search" }), 80);
  await docShot(page, "transactions-search");
  await page.keyboard.press("Escape");
});

test("transactions-columns-menu", async () => {
  await openRegister();
  await page.getByRole("button", { name: "Columns", exact: true }).click();
  const menu = page.getByRole("menu");
  await expect(menu.first()).toBeVisible();
  await scrollTo(page.getByText(/Showing 1 - \d+ of/).first());
  await docShot(page, "transactions-columns-menu");
  await page.keyboard.press("Escape");
});

test("transactions-calendar", async () => {
  await openRegister();
  const grid = page.getByRole("grid");
  await expect(async () => {
    const calendar = page.getByRole("button", {
      name: "Calendar",
      exact: true,
    });
    if ((await calendar.getAttribute("aria-pressed")) !== "true")
      await calendar.click();
    await expect(grid).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 30_000 });
  for (let i = 0; i < showcaseMonth().monthsBack; i++) {
    await page.getByRole("button", { name: "Previous month" }).click();
  }
  await expect(grid.getByText("Parents visiting").first()).toBeVisible({
    timeout: 30_000,
  });
  await settled();
  await scrollTo(page.getByRole("group", { name: "Layers" }));
  await docShot(page, "transactions-calendar");
});

test("transactions-account-view", async () => {
  await openRegister(`?accountId=${ids.chequing}`);
  await expect(page.getByText("Current Balance").first()).toBeVisible({
    timeout: 30_000,
  });
  await chartDrawn();
  await settled();
  await docShot(page, "transactions-account-view");
});

test("transactions-payee-view", async () => {
  await openRegister(`?payeeId=${ids.tim}`);
  await expect(page.getByText("Total Spent").first()).toBeVisible({
    timeout: 30_000,
  });
  await chartDrawn();
  await settled();
  await docShot(page, "transactions-payee-view");
});

test("transactions-bulk-update", async () => {
  await openRegister();
  await page
    .getByRole("button", { name: "Bulk Update", exact: true })
    .first()
    .click();
  const rows = page
    .getByRole("row")
    .filter({ has: page.getByRole("checkbox") });
  await expect(rows.nth(3)).toBeVisible();
  for (const index of [1, 2, 3])
    await rows.nth(index).getByRole("checkbox").check();
  await expect(page.getByText("3 transactions selected")).toBeVisible();
  // In bulk mode the filter panel's button reads Cancel Bulk, so this is the
  // selection banner's.
  await page.getByRole("button", { name: "Bulk Update", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Bulk Update Transactions" });
  await expect(dialog).toBeVisible();
  await settled();
  await docShot(page, "transactions-bulk-update", dialog);
  await cancel(dialog);
  await page.getByRole("button", { name: "Cancel Bulk" }).click();
});

test("transaction-form", async () => {
  const dialog = await openNewTransaction();
  await docShot(page, "transaction-form", dialog);
  await cancel(dialog);
});

test("transaction-quick-fill", async () => {
  const dialog = await openNewTransaction();
  await dialog
    .getByRole("button", { name: "Show recent transactions" })
    .click();
  await expect(
    page.getByText("Recent transactions", { exact: true }),
  ).toBeVisible();
  await settled();
  await docShot(page, "transaction-quick-fill", dialog);
  await cancel(dialog);
});

test("split-transaction", async () => {
  const dialog = await openNewTransaction();
  await dialog.getByRole("button", { name: "Split", exact: true }).click();
  await expect(dialog.getByText("Split Details")).toBeVisible();
  await settled();
  await docShot(page, "split-transaction", dialog);
  await cancel(dialog);
});

test("transaction-transfer-form", async () => {
  const dialog = await openNewTransaction();
  await dialog.getByRole("button", { name: "Transfer", exact: true }).click();
  await expect(dialog.getByText("To Account")).toBeVisible();
  await settled();
  await docShot(page, "transaction-transfer-form", dialog);
  await cancel(dialog);
});

test("transaction-attachments", async () => {
  await openRegister("?search=Avenida");
  const row = page.getByRole("row", { name: /Hotel Avenida Palace/ });
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.getByRole("cell").nth(2).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("button", { name: "Preview avenida-palace-invoice.png" }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await settled();
  const attachments = dialog.getByText("Attachments", { exact: true });
  await attachments.scrollIntoViewIfNeeded();
  await docShot(page, "transaction-attachments", dialog);
  await cancel(dialog);
});
