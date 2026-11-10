import {
  test,
  expect,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { apiFor, scrollUnderHeader, waitForReady } from "../readme/session";
import { cardOf, docShot, openDocsSession } from "./capture";

// website/docs/bills-and-deposits.md: the page, its forecast and list, the
// calendar view, and the schedule, post and occurrence dialogs. Every dialog
// is left with Cancel or Escape: nothing is posted, skipped or saved.

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  // Signing in loads the dashboard, which a busy development server can be slow to serve.
  test.setTimeout(300_000);
  context = await openDocsSession(browser);
  page = await context.newPage();
  await estimateTheHydroBill();
});

interface ScheduleRow {
  id: string;
  name: string;
  accountId: string;
  payeeId: string | null;
  categoryId: string | null;
  amountIsEstimated?: boolean;
}

/**
 * The demo's Hydro Bill with the Estimate option on (issue #2096), so the
 * pictures show an estimated bill. The demo holds twelve months of Hydro One
 * payments; the year before them, at the same seasonal shape and 5% cheaper,
 * is added once, so the estimate has two years to find the season in.
 */
async function estimateTheHydroBill(): Promise<void> {
  const api = apiFor(page);
  const schedules = await api.get<ScheduleRow[]>("/scheduled-transactions");
  const hydro = schedules.find((s) => s.name === "Hydro Bill");
  if (!hydro || !hydro.payeeId || !hydro.categoryId) {
    throw new Error("The demo data has no Hydro Bill with a payee and category");
  }
  if (hydro.amountIsEstimated) return;
  const today = new Date();
  for (let back = 13; back <= 24; back++) {
    const date = new Date(
      Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - back, 12),
    );
    // The demo's own shape: winter November to March, summer June to September.
    const month = date.getUTCMonth();
    const base =
      month >= 10 || month <= 2 ? 140 : month >= 5 && month <= 8 ? 95 : 110;
    await api.post("/transactions", {
      accountId: hydro.accountId,
      payeeId: hydro.payeeId,
      categoryId: hydro.categoryId,
      amount: -Math.round(base * 0.95 * 100) / 100,
      currencyCode: "CAD",
      transactionDate: date.toISOString().slice(0, 10),
      description: "Monthly electricity",
    });
  }
  await api.patch(`/scheduled-transactions/${hydro.id}`, {
    amountIsEstimated: true,
  });
}

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

async function openBills(): Promise<void> {
  await openPage("/bills");
  await expect(page.getByRole("row", { name: /Spotify/ }).first()).toBeVisible({
    timeout: 60_000,
  });
  await chartDrawn();
  await settled();
}

/** A row's action button, clicked until its dialog opens (hydration can eat the first). */
async function openFromRow(
  rowName: RegExp,
  action: string,
  dialogName: string,
): Promise<Locator> {
  const dialog = page.getByRole("dialog", { name: dialogName });
  await expect(async () => {
    if ((await dialog.count()) === 0) {
      await page
        .getByRole("row", { name: rowName })
        .first()
        .getByRole("button", { name: action })
        .click();
    }
    await expect(dialog).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  return dialog;
}

/** Leave a dialog unsaved: Cancel, and Discard if it asks. */
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

test("bills-deposits-page", async () => {
  await openBills();
  await docShot(page, "bills-deposits-page");
});

test("cash-flow-forecast", async () => {
  await openBills();
  const card = cardOf(
    page.getByRole("heading", { name: "Cash Flow Forecast" }),
  );
  await docShot(page, "cash-flow-forecast", card);
});

test("bills-list", async () => {
  await openBills();
  const list = cardOf(page.getByRole("table"));
  await list.scrollIntoViewIfNeeded();
  await docShot(page, "bills-list", list);
});

test("bills-calendar", async () => {
  await openBills();
  await page.getByRole("button", { name: "Calendar", exact: true }).click();
  const today = page.getByRole("button", { name: "Today", exact: true });
  await expect(today).toBeVisible();
  // The demo bills fall due early next month.
  await page.getByRole("button", { name: "Next month" }).click();
  await expect(page.getByText("Spotify").first()).toBeVisible();
  await settled();
  await scrollUnderHeader(page, today);
  await docShot(page, "bills-calendar");
  await page.getByRole("button", { name: "Table", exact: true }).click();
});

test("scheduled-transaction-form", async () => {
  await openBills();
  const dialog = page.getByRole("dialog", {
    name: "New Scheduled Transaction",
  });
  await expect(async () => {
    if ((await dialog.count()) === 0) {
      await page.getByRole("button", { name: "+ New Schedule" }).click();
    }
    await expect(dialog.getByText("Frequency").first()).toBeVisible({
      timeout: 5_000,
    });
  }).toPass({ timeout: 60_000 });
  await settled();
  await docShot(page, "scheduled-transaction-form", dialog);
  await cancel(dialog);
});

test("bills-post-transaction", async () => {
  await openBills();
  // The estimated bill: the dialog opens on this month's estimate.
  const dialog = await openFromRow(
    /Hydro Bill/,
    "Post Transaction",
    "Post Transaction",
  );
  await expect(dialog.getByText("Transaction Date")).toBeVisible();
  await settled();
  await docShot(page, "bills-post-transaction", dialog);
  await cancel(dialog);
});

test("bills-edit-occurrence", async () => {
  await openBills();
  const picker = await openFromRow(
    /Hydro Bill/,
    "Edit Occurrence",
    "Select Occurrence Date",
  );
  await picker.getByRole("button", { name: /Next Due/ }).click();
  const editor = page.getByRole("dialog", { name: "Edit Occurrence" });
  await expect(editor.getByText("Occurrence Date")).toBeVisible();
  await settled();
  await docShot(page, "bills-edit-occurrence", editor);
  await cancel(editor);
});

test("scheduled-transaction-estimate", async () => {
  await openBills();
  const dialog = await openFromRow(
    /Hydro Bill/,
    "Edit Schedule",
    "Edit Scheduled Transaction",
  );
  await expect(dialog.getByText(/Auto-calculated from payment history/)).toBeVisible({
    timeout: 30_000,
  });
  await settled();
  await docShot(page, "scheduled-transaction-estimate", dialog);
  await cancel(dialog);
});
