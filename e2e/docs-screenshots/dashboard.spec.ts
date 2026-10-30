import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { apiFor, waitForReady } from "../readme/session";
import { loadLookups, security } from "../readme/seed-lookup";
import { cardOf, docShot, openDocsSession } from "./capture";

// website/docs/dashboard.md: the whole dashboard, the Customize dialog, a
// widget's settings, and one picture per widget, cropped to its card.
//
// The demo user's layout holds the default widgets only, so the opt-in ones are
// appended to the end of it (and two securities starred for Favourite
// Securities) once, before the pictures: both additive, and skipped when a
// previous run already made them. Nothing is removed or reordered.

let context: BrowserContext;
let page: Page;

/** The opt-in widgets pictured below, in the order they are appended. */
const OPT_IN_WIDGETS = [
  "cash-flow-forecast",
  "favourite-securities",
  "spending-by-payee",
  "monthly-spending-trend",
  "income-by-source",
  "credit-utilization-accounts",
  "credit-utilization-total",
  "sector-weightings",
  "security-type-allocation",
  "geographic-allocation",
  "recurring-expenses",
  "weekend-weekday",
  "cash-flow-sankey",
];

/** The layout a user who never customized gets (widget-registry.tsx). */
const DEFAULT_WIDGETS = [
  "favourite-accounts",
  "upcoming-bills",
  "top-movers",
  "portfolio-value",
  "net-worth",
  "assets-liabilities",
  "expenses-pie",
  "income-expenses",
  "budget-status",
  "insights",
];

test.beforeAll(async ({ browser }) => {
  // Signing in loads the dashboard, which a busy development server can be slow to serve.
  test.setTimeout(300_000);
  context = await openDocsSession(browser);
  page = await context.newPage();
  await page.goto("/dashboard");
  const api = apiFor(page);

  const prefs = await api.get<{ dashboardWidgets: string[] }>(
    "/users/preferences",
  );
  const current =
    prefs.dashboardWidgets.length > 0
      ? prefs.dashboardWidgets
      : DEFAULT_WIDGETS;
  const missing = OPT_IN_WIDGETS.filter((id) => !current.includes(id));
  if (missing.length > 0) {
    await api.patch("/users/preferences", {
      dashboardWidgets: [...current, ...missing],
    });
  }

  const lookups = await loadLookups(api);
  for (const symbol of ["VOO", "AAPL", "XIU"]) {
    const found = security(lookups, symbol) as {
      id: string;
      isFavourite?: boolean;
    };
    const row = await api.get<{ isFavourite: boolean }>(
      `/securities/${found.id}`,
    );
    if (!row.isFavourite)
      await api.patch(`/securities/${found.id}`, { isFavourite: true });
  }
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

const widgetHeading = (title: string) =>
  page.getByRole("heading", { name: title, exact: true });

/**
 * The dashboard with every widget loaded. With the opt-in widgets added it
 * runs some twenty requests, which the development server can take a while
 * to answer, so the spinners get longer than the usual wait to clear. The
 * pictures share one page: the dashboard is loaded once per theme and every
 * later test reuses it.
 */
async function openDashboard(): Promise<void> {
  if (!new URL(page.url()).pathname.startsWith("/dashboard"))
    await openPage("/dashboard");
  await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.locator(".animate-spin, .animate-pulse")).toHaveCount(0, {
    timeout: 90_000,
  });
  await settled();
}

test("dashboard-overview", async () => {
  await openDashboard();
  await expect(page.getByRole("heading", { name: /Welcome/ })).toBeVisible();
  await expect(widgetHeading("Favourite Accounts")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, 0));
  await docShot(page, "dashboard-overview");
});

test("dashboard-header", async () => {
  await openDashboard();
  const customize = page.getByRole("button", {
    name: "Customize",
    exact: true,
  });
  await expect(customize).toBeVisible();
  await expect(
    page
      .getByRole("main")
      .getByRole("link", { name: "Shared Expenses", exact: true }),
  ).toHaveCount(0);
  await docShot(
    page,
    "dashboard-header",
    customize.locator("xpath=ancestor::div[.//h1][1]"),
  );
});

test("dashboard-customize", async () => {
  await openDashboard();
  await page.getByRole("button", { name: "Customize", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Customize dashboard" }),
  ).toBeVisible();
  await expect(dialog.getByText("Hidden widgets")).toBeVisible();
  // With every widget on the layout the dialog is taller than the desktop
  // viewport; a taller window shows all of it, down to its Save button.
  await page.setViewportSize({ width: 1600, height: 1400 });
  try {
    await docShot(page, "dashboard-customize", dialog);
  } finally {
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await page.setViewportSize({ width: 1600, height: 1000 });
  }
});

test("dashboard-widget-settings", async () => {
  await openDashboard();
  await page
    .getByRole("button", { name: "Configure Expenses by Category" })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Timeframe")).toBeVisible();
  await expect(dialog.getByText("Display name")).toBeVisible();
  await docShot(page, "dashboard-widget-settings", dialog);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});

test("dashboard-upcoming-bills-calendar", async () => {
  await openDashboard();
  const widget = cardOf(widgetHeading("Upcoming Bills & Deposits"));
  const calendar = widget.getByRole("button", {
    name: "Calendar",
    exact: true,
  });
  const list = widget.getByRole("button", { name: "List", exact: true });
  // The view is a saved widget setting: switch to the calendar for the
  // picture and back to the list the demo user had.
  await calendar.click();
  try {
    // The demo bills fall due early next month, so the calendar shows that one.
    await widget.getByRole("button", { name: "Next month" }).click();
    await settled();
    await widget.scrollIntoViewIfNeeded();
    await docShot(page, "dashboard-upcoming-bills-calendar", widget);
  } finally {
    await list.click();
    await expect(
      widget.getByRole("button", { name: "Next month" }),
    ).toHaveCount(0);
  }
});

for (const [name, title, ready] of [
  ["dashboard-favourite-account", "Favourite Accounts", "Primary Chequing"],
  ["dashboard-upcoming-bills", "Upcoming Bills & Deposits", "Gym Membership"],
  ["dashboard-top-movers", "Top Movers", "VOO"],
  ["dashboard-portfolio-value", "Portfolio Value over Time", null],
  ["dashboard-expenses-pie", "Expenses by Category", null],
  ["dashboard-income-expenses-bar", "Income vs Expenses", null],
  ["dashboard-budget-status", "Budget Status", "Safe to spend today"],
  ["dashboard-net-worth", "Net Worth", null],
  ["dashboard-assets-liabilities", "Assets vs Liabilities", null],
  ["dashboard-cash-flow-forecast", "Cash Flow Forecast", null],
  ["dashboard-favourite-securities", "Favourite Securities", "VOO"],
  ["dashboard-spending-by-payee", "Spending by Payee", null],
  ["dashboard-monthly-spending-trend", "Monthly Spending Trend", null],
  ["dashboard-income-by-source", "Income by Source", null],
  [
    "dashboard-credit-utilization-accounts",
    "Credit Utilization by Account",
    "Visa Rewards",
  ],
  ["dashboard-credit-utilization-total", "Total Credit Utilization", null],
  ["dashboard-sector-allocation", "Sector Allocation", null],
  ["dashboard-security-type-allocation", "Security Type Allocation", null],
  ["dashboard-geographic-allocation", "Geographic Allocation", null],
  ["dashboard-recurring-expenses", "Top Recurring Expenses", null],
  ["dashboard-weekend-weekday", "Weekend vs Weekday Spending", null],
  ["dashboard-cash-flow-sankey", "Cash Flow Sankey", null],
] as const) {
  test(name, async () => {
    await openDashboard();
    const heading = widgetHeading(title);
    await expect(heading).toBeVisible({ timeout: 30_000 });
    const widget = cardOf(heading);
    await widget.scrollIntoViewIfNeeded();
    if (ready) await expect(widget.getByText(ready).first()).toBeVisible();
    await settled();
    await docShot(page, name, widget);
  });
}
