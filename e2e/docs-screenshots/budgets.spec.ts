import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import type { ApiClient } from "../helpers/api";
import { apiFor, scrollUnderHeader, waitForReady } from "../readme/session";
import { loadIds, type Ids } from "../readme/ids";
import { loadLookups, need } from "../readme/seed-lookup";
import { todayYmd } from "../readme/settings";
import { cardOf, docShot, openDocsSession } from "./capture";

// website/docs/budgets.md. The wizard is walked to its last step and left
// without creating a budget; dialogs are opened and cancelled.
//
// The demo data stops at the end of last month, so the budget (which always
// shows the calendar month it is opened in) would read $0.00 everywhere. A
// month's worth of everyday spending is added first, the way the demo data
// spends: once, keyed on date, payee and amount, so a second run adds nothing.

test.describe.configure({ timeout: 300_000 });

let context: BrowserContext;
let page: Page;
let ids: Ids;

/** Day of the month, payee, category, account, amount (negative is spending). */
const THIS_MONTH: [number, string, string, string, number][] = [
  [1, "GoodLife Fitness", "Gym", "Primary Chequing", -49.99],
  [3, "Metro", "Groceries", "Visa Rewards", -112.4],
  [4, "Tim Hortons", "Coffee Shops", "Visa Rewards", -3.2],
  [5, "Aviva Insurance", "Car Insurance", "Primary Chequing", -185],
  [5, "Spotify", "Streaming Services", "Visa Rewards", -11.99],
  [6, "Uber Eats", "Restaurants", "Visa Rewards", -33.1],
  [8, "Esso", "Fuel", "Visa Rewards", -72.3],
  [9, "Amazon.ca", "Electronics", "Visa Rewards", -58.4],
  [10, "The Keg Steakhouse", "Restaurants", "Mastercard", -118.6],
  [12, "Metro", "Groceries", "Primary Chequing", -96.85],
  [12, "Hydro One", "Electricity", "Primary Chequing", -101.42],
  [14, "Rogers Internet", "Internet", "Primary Chequing", -79.99],
  [15, "Maple Leaf Technologies", "Salary", "Primary Chequing", 2250],
  [15, "Shoppers Drug Mart", "Pharmacy", "Primary Chequing", -18.75],
  [17, "Uber Eats", "Restaurants", "Visa Rewards", -41.25],
  [18, "Netflix", "Streaming Services", "Visa Rewards", -22.99],
  [19, "Starbucks", "Coffee Shops", "Visa Rewards", -6.85],
  [20, "Bell Canada", "Phone", "Primary Chequing", -65],
  [22, "Shell", "Fuel", "Visa Rewards", -66.15],
  [24, "Metro", "Groceries", "Visa Rewards", -143.27],
  [26, "Uber Eats", "Restaurants", "Visa Rewards", -38.9],
];

interface Row {
  transactionDate: string;
  payeeName: string | null;
  amount: string | number;
}

async function seedThisMonth(api: ApiClient): Promise<void> {
  const today = todayYmd();
  const [year, month, day] = today.split("-");
  const from = `${year}-${month}-01`;
  const existing = await api.get<{ data: Row[] }>(
    `/transactions?startDate=${from}&endDate=${today}&limit=200`,
  );
  const key = (date: string, payee: string | null, amount: number) =>
    `${date}|${payee}|${amount.toFixed(2)}`;
  const have = new Set(
    existing.data.map((t) =>
      key(t.transactionDate, t.payeeName, Number(t.amount)),
    ),
  );
  const lookups = await loadLookups(api);
  for (const [d, payee, category, accountName, amount] of THIS_MONTH) {
    if (d > Number(day)) continue;
    const date = `${year}-${month}-${String(d).padStart(2, "0")}`;
    if (have.has(key(date, payee, amount))) continue;
    const account = need(lookups.accounts, accountName, "account");
    await api.post("/transactions", {
      accountId: account.id,
      transactionDate: date,
      payeeId: need(lookups.payees, payee, "payee").id,
      payeeName: payee,
      categoryId: need(lookups.categories, category, "category").id,
      amount,
      currencyCode: account.currencyCode,
    });
  }
}

/** Open `path` and wait for it; the development build compiles a route on its first visit. */
async function go(path: string): Promise<void> {
  await page.goto(path);
  await expect(page.getByRole("main").first()).toBeVisible({ timeout: 90_000 });
  // A busy development server can keep a spinner turning past waitForReady's own wait.
  await expect(page.locator(".animate-spin, .animate-pulse")).toHaveCount(0, {
    timeout: 90_000,
  });
  await waitForReady(page);
}

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  context = await openDocsSession(browser);
  page = await context.newPage();
  await page.goto("/dashboard");
  const api = apiFor(page);
  ids = await loadIds(api);
  await seedThisMonth(api);
});

test.afterAll(async () => {
  await context.close();
});

const top = () => page.evaluate(() => window.scrollTo(0, 0));

/** The budget dashboard, once its figures and charts are in. */
async function openBudget(): Promise<void> {
  await go(`/budgets/${ids.budget}`);
  await expect(page.getByRole("heading", { name: "Health Score" })).toBeVisible(
    {
      timeout: 30_000,
    },
  );
  await expect(
    page.getByRole("heading", { name: "What-If Scenario Planner" }),
  ).toBeVisible();
  await waitForReady(page);
}

test("budgets-page", async () => {
  await go("/budgets");
  await expect(
    page.getByRole("heading", { name: "Budgets", level: 1 }),
  ).toBeVisible();
  await expect(page.getByRole("table")).toBeVisible();
  await docShot(page, "budgets-page");
});

test.describe("the budget wizard", () => {
  test.describe.configure({ mode: "serial" });

  test("budget-wizard-step1", async () => {
    await go("/budgets");
    await page
      .getByRole("button", { name: /New Budget/ })
      .first()
      .click();
    await expect(
      page.getByRole("heading", { name: "Choose a Budget Strategy" }),
    ).toBeVisible({
      timeout: 60_000,
    });
    await page.getByRole("button", { name: "12 months" }).click();
    await waitForReady(page);
    await top();
    await docShot(page, "budget-wizard-step1");
  });

  test("budget-wizard-step2", async () => {
    await page.getByRole("button", { name: "Analyze My Spending" }).click();
    await expect(
      page.getByRole("heading", { name: "Review Categories" }),
    ).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText("Food: Groceries")).toBeVisible();
    await waitForReady(page);
    await top();
    await docShot(page, "budget-wizard-step2");
  });

  test("budget-wizard-step3", async () => {
    await page.getByRole("button", { name: "Next: Configure" }).click();
    await expect(
      page.getByRole("heading", { name: "Configure Your Budget" }),
    ).toBeVisible();
    await waitForReady(page);
    await top();
    await docShot(page, "budget-wizard-step3");
  });

  test("budget-wizard-step4", async () => {
    await page.getByRole("button", { name: "Next: Review" }).click();
    await expect(
      page.getByRole("heading", { name: "Review Your Budget" }),
    ).toBeVisible();
    await waitForReady(page);
    await top();
    await docShot(page, "budget-wizard-step4");
  });
});

test("budget-dashboard", async () => {
  await openBudget();
  await top();
  await docShot(page, "budget-dashboard");
});

test("budget-health-velocity", async () => {
  await openBudget();
  const health = page.getByRole("heading", { name: "Health Score" });
  await scrollUnderHeader(page, health, 24);
  // The gauge and the velocity widget sit side by side in one row.
  const row = cardOf(health).locator("xpath=..");
  await docShot(page, "budget-health-velocity", row);
});

test("budget-category-list", async () => {
  await openBudget();
  const list = cardOf(page.getByRole("heading", { name: "Category Budgets" }));
  await expect(list).toBeVisible();
  await docShot(page, "budget-category-list", list);
});

test("budget-heatmap", async () => {
  await openBudget();
  const heatmap = cardOf(
    page.getByRole("heading", { name: /^Spending Heatmap/ }),
  );
  await scrollUnderHeader(page, heatmap);
  await docShot(page, "budget-heatmap", heatmap);
});

test("budget-trend-chart", async () => {
  await openBudget();
  const trend = cardOf(
    page.getByRole("heading", { name: "Budget vs Actual Trend" }),
  );
  await scrollUnderHeader(page, trend);
  await docShot(page, "budget-trend-chart", trend);
});

test("budget-scenario-planner", async () => {
  await openBudget();
  const heading = page.getByRole("heading", {
    name: "What-If Scenario Planner",
  });
  const planner = cardOf(heading);
  // Trim groceries, as a what-if; nothing is saved. The slider moves in steps of 5.
  const groceries = planner
    .getByTestId("scenario-categories")
    .locator(":scope > div")
    .filter({ hasText: /Groceries/ })
    .locator('input[type="range"]');
  await groceries.fill("300");
  await expect(planner.getByTestId("reset-scenario")).toBeVisible();
  // The planner lists every category; the picture is its top: the totals and the first sliders.
  await scrollUnderHeader(page, heading, 40);
  await docShot(page, "budget-scenario-planner");
});

test("budget-alert-badge", async () => {
  await openBudget();
  await top();
  await page
    .locator("header")
    .getByRole("button", { name: "Notifications", exact: true })
    .click();
  const panel = page.getByTestId("notification-list");
  await expect(panel).toBeVisible();
  await expect(panel.locator(".animate-spin")).toHaveCount(0);
  await docShot(page, "budget-alert-badge");
  await page.keyboard.press("Escape");
});

test("budget-edit-page", async () => {
  await go(`/budgets/${ids.budget}/edit`);
  await expect(
    page.getByRole("heading", { name: "Category Allocations" }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await top();
  await docShot(page, "budget-edit-page");
});

test("budget-category-edit", async () => {
  await go(`/budgets/${ids.budget}/edit`);
  await page.getByRole("button", { name: /^Food: Groceries / }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Edit Food: Groceries" }),
  ).toBeVisible();
  await docShot(page, "budget-category-edit", dialog);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});
