import {
  test,
  expect,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { apiFor, scrollUnderHeader, waitForReady } from "../readme/session";
import { cardOf, docShot, openDocsSession } from "./capture";

// website/docs/reports.md (and the report pictures budgets.md and
// currency-management.md show). The builders are filled in for the picture
// and left without saving.

test.describe.configure({ timeout: 300_000 });

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(300_000);
  context = await openDocsSession(browser);
  page = await context.newPage();
  await page.goto("/dashboard");
});

test.afterAll(async () => {
  await context.close();
});

const top = () => page.evaluate(() => window.scrollTo(0, 0));
const chartDrawn = () =>
  expect(page.locator(".recharts-surface").first()).toBeVisible({
    timeout: 60_000,
  });

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

/** A built-in report, once its first chart (or `ready`) is on screen. */
async function openReport(slug: string, ready?: Locator): Promise<void> {
  await go(`/reports/${slug}`);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  if (ready) await expect(ready).toBeVisible({ timeout: 60_000 });
  else await chartDrawn();
  await expect(page.locator(".animate-spin, .animate-pulse")).toHaveCount(0, {
    timeout: 90_000,
  });
  await waitForReady(page);
}

/** The id of the saved custom report called `name` in the demo data. */
async function customReportId(name: string): Promise<string> {
  const reports =
    await apiFor(page).get<{ id: string; name: string }[]>("/reports/custom");
  const found = reports.find((r) => r.name === name);
  if (!found)
    throw new Error(`The demo data has no custom report named "${name}".`);
  return found.id;
}

test("reports-page", async () => {
  await go("/reports");
  await expect(page.getByRole("group", { name: "Category" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Spending by Category", exact: true }),
  ).toBeVisible();
  await docShot(page, "reports-page");
});

test("report-spending-category", async () => {
  await openReport("spending-by-category");
  await top();
  await docShot(page, "report-spending-category");
});

test("report-income-expenses", async () => {
  await openReport("income-vs-expenses");
  await expect(page.getByText("Total Income")).toBeVisible();
  await top();
  await docShot(page, "report-income-expenses");
});

test("report-tag-breakdown", async () => {
  await openReport("income-vs-expenses");
  await page.getByRole("combobox").first().selectOption({ label: "project" });
  await chartDrawn();
  await waitForReady(page);
  const breakdown = page.getByRole("heading", {
    name: /Break down by tag key/,
  });
  await expect(breakdown).toBeVisible();
  await scrollUnderHeader(page, breakdown, 40);
  await docShot(page, "report-tag-breakdown");
});

test("report-net-worth", async () => {
  await openReport("net-worth");
  await top();
  await docShot(page, "report-net-worth");
});

test("report-monthly-breakdown", async () => {
  await openReport(
    "monthly-category-breakdown",
    page.getByRole("table").first(),
  );
  await top();
  await docShot(page, "report-monthly-breakdown");
});

test("report-cash-flow-sankey", async () => {
  await openReport(
    "cash-flow-sankey",
    page.getByRole("img", { name: /^Cash flow diagram/ }),
  );
  await top();
  await docShot(page, "report-cash-flow-sankey");
});

test("report-portfolio-value", async () => {
  await openReport("portfolio-value");
  await top();
  await docShot(page, "report-portfolio-value");
});

test("report-security-performance", async () => {
  await go("/reports/security-performance");
  // Three of the demo holdings, compared on one chart.
  await page.getByRole("button", { name: "Select securities..." }).click();
  for (const name of [
    "VFV - Vanguard S&P 500 Index ETF",
    "XAW - iShares Core MSCI All Country World ex Canada",
    "XIU - iShares S&P/TSX 60 Index ETF",
  ]) {
    await page.getByRole("checkbox", { name }).check();
  }
  // Close the list by clicking away from it.
  await page.getByRole("heading", { level: 1 }).click();
  await expect(page.getByPlaceholder("Search...")).toHaveCount(0);
  await chartDrawn();
  await expect(page.locator(".animate-spin, .animate-pulse")).toHaveCount(0, {
    timeout: 90_000,
  });
  await waitForReady(page);
  await top();
  await docShot(page, "report-security-performance");
});

test("report-currency-exposure", async () => {
  await openReport("currency-exposure");
  await top();
  await docShot(page, "report-currency-exposure");
});

test("report-foreign-currency-fees", async () => {
  await openReport(
    "foreign-currency-fees",
    page.getByText("Hotel Avenida Palace").first(),
  );
  await top();
  await docShot(page, "report-foreign-currency-fees");
});

test("report-monte-carlo", async () => {
  await go("/reports/monte-carlo-simulation");
  await page.getByText("Retire at 60, balanced portfolio").first().click();
  await page.getByRole("button", { name: "Run simulation" }).click();
  await expect(
    page.getByRole("heading", { name: "Performance Summary" }),
  ).toBeVisible({
    timeout: 60_000,
  });
  await chartDrawn();
  await waitForReady(page);
  await scrollUnderHeader(
    page,
    page.getByRole("button", { name: "Run again" }),
    40,
  );
  await docShot(page, "report-monte-carlo");
});

test("report-budget-vs-actual", async () => {
  await openReport("budget-vs-actual");
  await top();
  await docShot(page, "report-budget-vs-actual");
});

test("report-budget-health-score", async () => {
  await openReport(
    "budget-health-score",
    page.getByText(/Excellent|Good|Needs Attention|Off Track/).first(),
  );
  await top();
  await docShot(page, "report-budget-health-score");
});

test("report-switcher", async () => {
  await openReport("spending-by-category");
  await top();
  await page.getByRole("button", { name: "Switch to another report" }).click();
  await expect(page.getByPlaceholder("Filter reports...")).toBeVisible();
  await docShot(page, "report-switcher");
  await page.keyboard.press("Escape");
});

test("custom-report-builder", async () => {
  await go("/reports/custom/new");
  await expect(
    page.getByRole("heading", { name: "Create Custom Report" }),
  ).toBeVisible();
  await page.getByLabel("Report Name").fill("Monthly Food Spending");
  await page.getByLabel("Group By").selectOption({ label: "Month" });
  await page.getByLabel("Timeframe").selectOption({ label: "Last 12 Months" });
  await top();
  await docShot(page, "custom-report-builder");
});

test("report-filter-builder", async () => {
  await go("/reports/custom/new");
  const filters = cardOf(
    page.getByRole("heading", { name: "Filters (optional)" }),
  );
  await filters.getByRole("button", { name: "Add filter group" }).click();
  await expect(
    filters.getByRole("button", { name: "Add OR condition" }),
  ).toBeVisible();
  await scrollUnderHeader(page, filters);
  await docShot(page, "report-filter-builder", filters);
});

test("report-chart-table", async () => {
  const id = await customReportId("Dining & Entertainment");
  await go(`/reports/custom/${id}`);
  await expect(page.getByRole("table").first()).toBeVisible({
    timeout: 60_000,
  });
  await waitForReady(page);
  await top();
  await docShot(page, "report-chart-table");
});

test("report-custom-chart", async () => {
  const id = await customReportId("Monthly Spending by Category");
  await go(`/reports/custom/${id}`);
  await chartDrawn();
  await waitForReady(page);
  await top();
  await docShot(page, "report-custom-chart");
});

test("report-investment-builder", async () => {
  await go("/reports/investment/new");
  await expect(
    page.getByRole("heading", { name: "Create Investment Report" }),
  ).toBeVisible();
  await page.getByLabel("Report Name").fill("Holdings by currency");
  await top();
  await docShot(page, "report-investment-builder");
});
