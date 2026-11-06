import {
  test,
  expect,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { apiFor, scrollUnderHeader, waitForReady } from "../readme/session";
import { loadIds, type Ids } from "../readme/ids";
import { loadLookups, need, type Lookups } from "../readme/seed-lookup";
import { cardOf, docShot, openDocsSession } from "./capture";

// website/docs/accounts.md: the account list, the account form (left with
// Cancel, never saved), a detail page per account type, and a reconciliation
// that is started but never finished.

let context: BrowserContext;
let page: Page;
let ids: Ids;
let lookups: Lookups;

test.beforeAll(async ({ browser }) => {
  // Signing in loads the dashboard, which a busy development server can be slow to serve.
  test.setTimeout(300_000);
  context = await openDocsSession(browser);
  page = await context.newPage();
  await page.goto("/dashboard");
  const api = apiFor(page);
  ids = await loadIds(api);
  lookups = await loadLookups(api);
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

const accountId = (name: string) => need(lookups.accounts, name, "account").id;

/** A chart has drawn when Recharts has put an SVG surface on the page. */
const chartDrawn = () =>
  expect(page.locator(".recharts-surface").first()).toBeVisible({
    timeout: 30_000,
  });

const scrollTo = (locator: Locator, gap = 16) =>
  scrollUnderHeader(page, locator, gap);

/**
 * The New Account dialog. A click that lands before the page has hydrated
 * opens nothing, so the click is retried until the dialog is there.
 */
async function openNewAccount(): Promise<Locator> {
  const dialog = page.getByRole("dialog");
  await expect(async () => {
    if ((await dialog.count()) === 0) {
      await page.getByRole("button", { name: "+ New Account" }).click();
    }
    await expect(dialog.getByLabel("Account Name")).toBeVisible({
      timeout: 5_000,
    });
  }).toPass({ timeout: 60_000 });
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

test("accounts-list", async () => {
  await openPage("/accounts");
  await expect(page.getByText("Car Loan").first()).toBeVisible();
  await expect(page.getByText("Bitcoin Wallet").first()).toBeVisible();
  await expect(page.getByText(/\d+ of \d+ accounts/)).toBeVisible();
  await docShot(page, "accounts-list");
});

test("accounts-institutions", async () => {
  await openPage("/institutions");
  await expect(page.getByText("TD Canada Trust").first()).toBeVisible();
  await docShot(page, "accounts-institutions");
});

test("create-account-form", async () => {
  await openPage("/accounts");
  const dialog = await openNewAccount();
  await expect(dialog.getByLabel("Account Name")).toBeVisible();
  await settled();
  await docShot(page, "create-account-form", dialog);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});

test("create-account-form-crypto", async () => {
  // Never saved: the demo data already holds a Bitcoin Wallet.
  await openPage("/accounts");
  const dialog = await openNewAccount();
  await dialog.getByLabel("Account Name").fill("Bitcoin Wallet");
  await dialog
    .getByLabel("Account Type")
    .selectOption({ label: "Crypto Wallet" });
  const currency = dialog.getByLabel("Currency", { exact: true });
  await expect(currency.locator("option", { hasText: /^BTC - / })).toHaveCount(
    1,
  );
  await currency.selectOption("BTC");
  await expect(currency).toHaveValue("BTC");
  await dialog.getByLabel("Account Name").click();
  await settled();
  await docShot(page, "create-account-form-crypto", dialog);
  await cancel(dialog);
});

test("account-form-mortgage", async () => {
  await openPage("/accounts");
  const dialog = await openNewAccount();
  await dialog.getByLabel("Account Type").selectOption("MORTGAGE");
  await expect(dialog.getByText("Mortgage Details").first()).toBeVisible();
  await settled();
  await docShot(page, "account-form-mortgage", dialog);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});

test("account-form-mortgage-fees", async () => {
  await openPage("/accounts");
  const dialog = await openNewAccount();
  await dialog.getByLabel("Account Type").selectOption("MORTGAGE");
  await expect(dialog.getByText("Mortgage Details").first()).toBeVisible();
  await dialog.getByRole("button", { name: "Add a fee" }).click();
  await dialog.getByLabel("Fee name").fill("Property tax");
  const category = dialog.getByLabel("Category", { exact: true });
  await category.click();
  await category.pressSequentially("Property Tax");
  await page
    .getByText("Housing: Property Tax", { exact: true })
    .first()
    .click();
  await dialog.getByLabel("Value applies").selectOption("ANNUAL");
  await dialog.getByLabel("Amount", { exact: true }).fill("3600");
  await dialog.getByLabel("Fee name").click();
  const section = dialog
    .locator("div.border-t")
    .filter({ has: page.getByRole("heading", { name: "Mortgage fees" }) })
    .last();
  // Inside the dialog's own scroll area, not under the page header.
  await section.scrollIntoViewIfNeeded();
  await settled();
  await docShot(page, "account-form-mortgage-fees", section);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});

test("loan-fees-panel", async () => {
  // Seeded for the picture and removed after it, so the mortgage's bill is
  // what every other picture shows.
  const api = apiFor(page);
  // By parent and name: the demo tree repeats a name under several parents.
  const categories =
    await api.get<{ id: string; name: string; parentId: string | null }[]>(
      "/categories",
    );
  const category = (parent: string, name: string): string => {
    const top = categories.find((c) => c.name === parent && !c.parentId);
    const child = categories.find(
      (c) => c.name === name && c.parentId === top?.id,
    );
    if (!child) throw new Error(`No category ${parent} > ${name}`);
    return child.id;
  };
  await api.put(`/accounts/${ids.mortgage}/loan-fees`, {
    fees: [
      {
        categoryId: category("Housing", "Property Tax"),
        name: "Property tax",
        calculation: "FIXED",
        basis: "ANNUAL",
        amount: 3600,
      },
      {
        categoryId: category("Bills & Utilities", "Insurance"),
        name: "Mortgage default insurance",
        calculation: "PERCENT_CURRENT_BALANCE",
        basis: "ANNUAL",
        rate: 0.25,
      },
    ],
  });
  try {
    await openPage(`/accounts/${ids.mortgage}`);
    const heading = page.getByRole("heading", { name: "Mortgage fees" });
    await expect(page.getByText("Mortgage default insurance")).toBeVisible();
    await scrollTo(heading, 40);
    await settled();
    await docShot(page, "loan-fees-panel", cardOf(heading));
  } finally {
    await api.put(`/accounts/${ids.mortgage}/loan-fees`, { fees: [] });
  }
});

test("account-banking-detail", async () => {
  await openPage(`/accounts/${ids.chequing}`);
  await expect(
    page.getByRole("heading", { name: "Balance History" }),
  ).toBeVisible();
  await chartDrawn();
  await settled();
  await docShot(page, "account-banking-detail");
});

test("account-crypto-detail", async () => {
  await openPage(`/accounts/${accountId("Bitcoin Wallet")}`);
  await expect(
    page.getByRole("heading", { name: "Balance History" }),
  ).toBeVisible();
  await expect(
    page.getByRole("article", { name: "Current Balance" }),
  ).toContainText("0.00704283", { timeout: 30_000 });
  await chartDrawn();
  await settled();
  await page.evaluate(() => window.scrollTo(0, 0));
  await docShot(page, "account-crypto-detail");
});

test("crypto-transfer-fee-split", async () => {
  // The wallet's register, the sale's edit dialog with its two split lines;
  // left with Cancel.
  await openPage(`/transactions?accountIds=${accountId("Bitcoin Wallet")}`);
  const table = page.getByRole("button", { name: "Table", exact: true });
  await expect(table).toBeVisible({ timeout: 90_000 });
  if ((await table.getAttribute("aria-pressed")) !== "true")
    await table.click();
  // The sale: the split whose lines are the transfer and the network fee.
  const row = page
    .getByRole("row", { name: /Split \(2\) → Primary Chequing/ })
    .first();
  await expect(row).toBeVisible({ timeout: 90_000 });
  await settled();
  const dialog = page.getByRole("dialog");
  await expect(async () => {
    if ((await dialog.count()) === 0) {
      await row.getByRole("button", { name: "Edit", exact: true }).click();
    }
    await expect(dialog.getByText("Split Details")).toBeVisible({
      timeout: 5_000,
    });
  }).toPass({ timeout: 60_000 });
  // The fee line's memo is an input's value, which no text locator reads.
  await expect
    .poll(
      () =>
        dialog
          .locator("input")
          .evaluateAll((inputs) =>
            inputs.some((i) => (i as HTMLInputElement).value === "Network fee"),
          ),
      { timeout: 30_000 },
    )
    .toBe(true);
  await settled();
  await docShot(page, "crypto-transfer-fee-split", dialog);
  await cancel(dialog);
});

test("account-credit-card-detail", async () => {
  await openPage(`/accounts/${ids.visa}`);
  await expect(page.getByText("Current Statement Cycle")).toBeVisible();
  await chartDrawn();
  await settled();
  await docShot(page, "account-credit-card-detail");
});

test("account-asset-detail", async () => {
  await openPage(`/accounts/${ids.vehicle}`);
  await expect(page.getByText("Linked to Car Loan")).toBeVisible();
  await chartDrawn();
  await settled();
  await docShot(page, "account-asset-detail");
});

test("account-investment-detail", async () => {
  await openPage(`/accounts/${accountId("RRSP - Retirement - Brokerage")}`);
  await expect(page.getByText("Investment Income")).toBeVisible();
  await settled();
  await docShot(page, "account-investment-detail");
});

test("loan-detail-page", async () => {
  await openPage(`/accounts/${ids.carLoan}`);
  await expect(
    page.getByRole("heading", { name: "Loan Schedule" }),
  ).toBeVisible();
  await chartDrawn();
  await settled();
  await docShot(page, "loan-detail-page");
});

test("account-mortgage-simulator", async () => {
  await openPage(`/accounts/${ids.mortgage}`);
  await expect(page.getByText("Rate History").first()).toBeVisible();
  await page
    .getByRole("button", { name: "Show scenario comparison chart" })
    .click();
  await chartDrawn();
  await settled();
  await scrollTo(
    page.getByRole("heading", { name: "Overpayment Simulator" }),
    40,
  );
  await docShot(page, "account-mortgage-simulator");
});

test("account-line-of-credit-detail", async () => {
  await openPage(`/accounts/${accountId("Home Equity Line of Credit")}`);
  await chartDrawn();
  await settled();
  await docShot(page, "account-line-of-credit-detail");
});

test("account-reconciliation", async () => {
  await openPage(`/reconcile?accountId=${ids.chequing}`);
  await expect(
    page.getByRole("heading", { name: "Start Reconciliation" }),
  ).toBeVisible();
  // The statement date and balance start at today and the account's balance.
  await page.getByRole("button", { name: "Start Reconciliation" }).click();
  await expect(page.getByText(/Unreconciled Transactions \(\d+\)/)).toBeVisible(
    {
      timeout: 30_000,
    },
  );
  await settled();
  await page.evaluate(() => window.scrollTo(0, 0));
  await docShot(page, "account-reconciliation");
});
