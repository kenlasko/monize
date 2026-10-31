import {
  test,
  expect,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { apiFor, waitForReady } from "../readme/session";
import { loadIds, type Ids } from "../readme/ids";
import { STATE_FILE } from "../readme/settings";
import { docShot, openDocsSession } from "./capture";

// website/docs/categories-and-payees.md. Every dialog is opened, photographed
// and closed with Cancel or Escape; nothing is saved, merged or deleted.

// A first visit to a route compiles it on the development server: minutes, not seconds.
test.describe.configure({ timeout: 360_000 });

let context: BrowserContext;
let page: Page;
let ids: Ids;

test.beforeAll(async ({ browser }) => {
  context = await openDocsSession(browser);
  page = await context.newPage();
  await page.goto("/dashboard");
  ids = await loadIds(apiFor(page));
});

/**
 * Keep the shared session file current. The server rotates the sign-in cookies
 * as a context refreshes them, so a later context (the next file, or a worker
 * restarted after a failure) would otherwise start from cookies that no longer
 * work.
 */
const saveSession = () =>
  context.storageState({ path: STATE_FILE }).catch(() => undefined);

test.afterAll(async () => {
  await saveSession();
  await context.close();
});

/** A taller window for the dialogs that scroll inside a 1000-pixel one. */
const TALL = { width: 1600, height: 1500 };

test.afterEach(async () => {
  await saveSession();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1600, height: 1000 });
});

/**
 * Open `path` and wait for it to settle. The development server compiles a
 * route on its first visit, and the service worker answers a navigation that
 * takes too long with its offline page, so a first attempt can land there.
 * `ready`, when given, is what the page shows once its data has loaded.
 */
async function go(p: Page, path: string, ready?: Locator): Promise<void> {
  await expect(async () => {
    await p.goto(path);
    await expect(p.getByRole("main").first()).toBeVisible({ timeout: 20_000 });
    // A request the busy server dropped shows an error card: load the page again.
    if (ready) await expect(ready).toBeVisible({ timeout: 30_000 });
  }).toPass({ timeout: 300_000 });
  await waitForReady(p);
}

/** A chart has drawn when Recharts has put an SVG surface on the page. */
const chartDrawn = (p: Page) =>
  expect(p.locator(".recharts-surface").first()).toBeVisible();

/** The list row of a category or payee, by its exact name. */
const rowOf = (name: string) =>
  page
    .getByRole("main")
    .locator("tr")
    .filter({ has: page.getByRole("button", { name, exact: true }) })
    .first();

// ---------------------------------------------------------------- categories

test("categories-page", async () => {
  await go(page, "/categories");
  await expect(rowOf("Restaurants")).toBeVisible();
  await docShot(page, "categories-page");
});

test("categories-edit-dialog", async () => {
  await go(page, "/categories");
  await rowOf("Restaurants")
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Edit Category" }),
  ).toBeVisible();
  await expect(dialog.getByLabel("Category Name")).toHaveValue("Restaurants");
  await docShot(page, "categories-edit-dialog", dialog);
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("categories-delete-dialog", async () => {
  await go(page, "/categories");
  await rowOf("Restaurants")
    .getByRole("button", { name: "Delete", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: 'Delete "Restaurants"' });
  await expect(dialog.getByText("Reassign to:")).toBeVisible({
    timeout: 30_000,
  });
  await docShot(page, "categories-delete-dialog", dialog);
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("categories-detail", async () => {
  await go(
    page,
    `/categories/${ids.restaurants}`,
    page.getByRole("heading", { name: "Monthly Totals" }),
  );
  await chartDrawn(page);
  await waitForReady(page);
  await docShot(page, "categories-detail");
});

// -------------------------------------------------------------------- payees

test("payees-page", async () => {
  await go(page, "/payees");
  await expect(rowOf("Tim Hortons")).toBeVisible();
  await docShot(page, "payees-page");
});

test("payees-edit-dialog", async () => {
  await page.setViewportSize(TALL);
  await go(page, "/payees");
  await rowOf("Tim Hortons")
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Edit Payee" }),
  ).toBeVisible();
  await expect(
    dialog.getByText("Aliases", { exact: true }).first(),
  ).toBeVisible();
  await waitForReady(page);
  await docShot(page, "payees-edit-dialog", dialog);
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("payees-detail", async () => {
  await go(
    page,
    `/payees/${ids.tim}`,
    page.getByText("guestexperience@timhortons.example"),
  );
  await chartDrawn(page);
  await waitForReady(page);
  await docShot(page, "payees-detail");
});

test("payees-merge-dialog", async () => {
  await go(page, "/payees");
  await rowOf("No Frills")
    .getByRole("button", { name: "Merge", exact: true })
    .click();
  const dialog = page.getByRole("dialog", { name: "Merge Payee" });
  await expect(dialog).toBeVisible();
  const target = dialog.getByPlaceholder("Select target payee...");
  await target.click();
  await target.pressSequentially("Loblaws");
  // The combobox's options are plain elements, not ARIA options.
  await page
    .locator("[data-option-index]")
    .filter({ hasText: "Loblaws" })
    .first()
    .click({ timeout: 30_000 });
  await expect(dialog.getByText("This will:")).toBeVisible();
  await docShot(page, "payees-merge-dialog", dialog);
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

/** Open one of the Payees page's Maintenance tools. */
async function maintenance(item: string): Promise<void> {
  await go(page, "/payees");
  await expect(async () => {
    await page.getByRole("button", { name: "Maintenance" }).click();
    await page.getByRole("menuitem", { name: item }).click({ timeout: 3000 });
  }).toPass({ timeout: 60_000 });
}

test("payees-auto-merge", async () => {
  await page.setViewportSize(TALL);
  await maintenance("Auto-Merge Payees");
  const dialog = page.getByRole("dialog", { name: "Auto-Merge Payees" });
  await dialog.getByRole("button", { name: "Preview Groups" }).click();
  await expect(
    dialog.getByText(/Groups \(\d+ found\)|No merge groups match/).first(),
  ).toBeVisible({
    timeout: 30_000,
  });
  await waitForReady(page);
  await docShot(page, "payees-auto-merge", dialog);
});

test("payees-deactivate-unused", async () => {
  await page.setViewportSize(TALL);
  await maintenance("Deactivate Unused");
  const dialog = page.getByRole("dialog", { name: "Deactivate Unused Payees" });
  // The widest net the sliders allow: up to 20 transactions, unused for 6 months.
  await dialog.getByRole("slider").nth(0).press("End");
  await dialog.getByRole("slider").nth(1).press("Home");
  await dialog.getByRole("button", { name: "Preview Unused Payees" }).click();
  await expect(
    dialog.getByText(/Candidates \(\d+ found\)|No payees match/).first(),
  ).toBeVisible({
    timeout: 30_000,
  });
  await waitForReady(page);
  await docShot(page, "payees-deactivate-unused", dialog);
});

test("payees-auto-assign", async () => {
  await page.setViewportSize(TALL);
  await maintenance("Auto-Assign Categories");
  const dialog = page.getByRole("dialog", {
    name: "Auto-Assign Default Categories",
  });
  // Every demo payee already has a default category: include them, so the
  // preview has suggestions to show.
  await dialog.getByRole("slider").nth(0).press("Home");
  await dialog.getByText("Only payees without a default category").click();
  await dialog.getByRole("button", { name: "Preview Suggestions" }).click();
  await expect(
    dialog.getByText(/Suggestions \(\d+ found\)|No payees match/).first(),
  ).toBeVisible({
    timeout: 30_000,
  });
  await waitForReady(page);
  await docShot(page, "payees-auto-assign", dialog);
});

test("payees-lookup-settings", async () => {
  await page.setViewportSize(TALL);
  await maintenance("Payee Lookup settings");
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await waitForReady(page);
  await docShot(page, "payees-lookup-settings", dialog);
});
