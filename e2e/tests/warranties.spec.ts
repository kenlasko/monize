import { randomInt } from "crypto";
import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import {
  createAccount,
  createTransaction,
  createWarranty,
} from "../helpers/factories";
import { uniqueId } from "../helpers/api";
import { syntheticDocumentPng } from "../helpers/document-fixture";

/** A YYYY-MM-DD date `days` from today (negative for the past), in UTC as the factories date rows. */
function isoDaysFromToday(days: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The register's row for a seeded transaction, by its unique payee. */
function registerRow(page: Page, payeeName: string) {
  return page.locator("tr", { hasText: payeeName }).first();
}

/** Right-click a register row until its action sheet opens (the list hydrates late). */
async function openActionSheet(page: Page, payeeName: string) {
  const sheet = page.getByRole("dialog");
  await expect(async () => {
    await registerRow(page, payeeName).click({ button: "right" });
    await expect(sheet).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30000 });
  return sheet;
}

/**
 * Click a register row's amount until its edit window opens. The amount cell
 * does not stop propagation, and the list hydrates late, so a single click can
 * land before the row's handler exists.
 */
async function openEditWindow(
  page: Page,
  payeeName: string,
  amountText: string,
) {
  const dialog = page.getByRole("dialog");
  await expect(async () => {
    await registerRow(page, payeeName).getByText(amountText).first().click();
    await expect(dialog).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30000 });
  return dialog;
}

// Seeded through the API, driven through the UI, and re-checked after a reload
// so a passing step is the server's state rather than an optimistic render.
test.describe("Warranties", () => {
  test("adds a warranty from a transaction's edit window and shows its badge", async ({
    authedPage: page,
    api,
  }) => {
    // The register's Attachments column, where the shield sits beside the
    // paperclip, is the lowest tier: it renders only on a wide register.
    await page.setViewportSize({ width: 2400, height: 1200 });

    const account = await createAccount(api);
    const payeeName = `Warranty Buy ${uniqueId()}`;
    const amount = -randomInt(10000, 99999) / 100;
    await createTransaction(api, { accountId: account.id, payeeName, amount });

    const amountText = Math.abs(amount).toFixed(2);

    await page.goto("/transactions?basis=cash");
    const editWindow = await openEditWindow(page, payeeName, amountText);
    await editWindow
      .getByRole("button", { name: "Add warranty", exact: true })
      .click();

    // The form opens filled from the purchase.
    await expect(page).toHaveURL(/\/warranties/);
    const form = page.getByRole("dialog", { name: "New warranty" });
    await expect(form).toBeVisible({ timeout: 15000 });
    await expect(form.getByLabel("Name", { exact: true })).toHaveValue(
      payeeName,
    );
    await form
      .getByRole("button", { name: "Add warranty", exact: true })
      .click();
    await expect(form).toHaveCount(0);

    // The page is left filtered to that purchase, with the new warranty in it.
    await expect(page.locator("tr", { hasText: payeeName })).toBeVisible();

    await page.goto("/transactions?basis=cash");
    const badge = registerRow(page, payeeName).getByRole("img", {
      name: "1 warranty",
    });
    await expect(badge).toBeVisible({ timeout: 15000 });
    await page.reload();
    await expect(badge).toBeVisible({ timeout: 15000 });

    // The edit window lists the linked warranty.
    const again = await openEditWindow(page, payeeName, amountText);
    await expect(
      again.getByRole("link", { name: new RegExp(payeeName) }),
    ).toBeVisible({ timeout: 15000 });
    await again.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(again).toHaveCount(0);

    // A row's action sheet offers no warranty action: the shield says one
    // exists, and adding one goes through the form or the Warranties page.
    const sheet = await openActionSheet(page, payeeName);
    await expect(
      sheet.getByRole("button", { name: "Edit", exact: true }),
    ).toBeVisible();
    await expect(sheet.getByRole("button", { name: /warrant/i })).toHaveCount(
      0,
    );
  });

  test("uploads a receipt on the detail page and lists it with its kind", async ({
    authedPage: page,
    api,
  }) => {
    const warranty = await createWarranty(api, {
      name: `Receipt Kettle ${uniqueId()}`,
    });

    await page.goto("/warranties");
    // A row opens the detail page; retry until the row's handler has hydrated.
    await expect(async () => {
      await page.locator("tr", { hasText: warranty.name }).first().click();
      await expect(page).toHaveURL(new RegExp(`/warranties/${warranty.id}$`), {
        timeout: 2000,
      });
    }).toPass({ timeout: 30000 });
    await expect(
      page.getByRole("heading", { name: warranty.name }),
    ).toBeVisible();

    const documents = page.getByRole("region", { name: "Documents" });
    await expect(documents.getByText("No documents yet")).toBeVisible();
    // The upload carries no kind picker: a new document is stored as Other.
    await expect(
      documents.getByLabel("Document type", { exact: true }),
    ).toHaveCount(0);
    await documents.getByLabel("Add attachment").setInputFiles({
      name: "proof-of-purchase.png",
      mimeType: "image/png",
      buffer: syntheticDocumentPng(),
    });

    const row = documents.locator("li", { hasText: "proof-of-purchase.png" });
    await expect(row).toBeVisible({ timeout: 15000 });
    // The owner's row carries its kind as a picker, set after upload.
    const kind = row.getByRole("combobox", {
      name: "Document type for proof-of-purchase.png",
    });
    await expect(kind).toHaveValue("other");
    const saved = page.waitForResponse(
      (response) =>
        response.request().method() === "PATCH" &&
        /\/attachments\/[^/]+$/.test(new URL(response.url()).pathname),
    );
    await kind.selectOption("receipt");
    expect((await saved).ok()).toBe(true);
    await expect(kind).toHaveValue("receipt");

    await page.reload();
    await expect(row).toBeVisible({ timeout: 15000 });
    // The kind was stored: the row reads it back after a reload.
    await expect(kind).toHaveValue("receipt");
    await expect(kind.locator("option:checked")).toHaveText("Receipt");
  });

  test("filters, searches and archives a warranty on the Warranties page", async ({
    authedPage: page,
    api,
  }) => {
    const active = await createWarranty(api, {
      name: `Active Mixer ${uniqueId()}`,
      purchaseDate: isoDaysFromToday(-10),
      expiresOn: isoDaysFromToday(2 * 365),
    });
    const expired = await createWarranty(api, {
      name: `Expired Drill ${uniqueId()}`,
      purchaseDate: isoDaysFromToday(-3 * 365),
      expiresOn: isoDaysFromToday(-365),
    });
    const activeRow = page.locator("tr", { hasText: active.name });
    const expiredRow = page.locator("tr", { hasText: expired.name });

    await page.goto("/warranties");
    await expect(activeRow).toBeVisible();
    await expect(expiredRow).toBeVisible();

    // Status pills, not the summary cards above them that share the labels.
    const filters = page.getByRole("group", { name: "Filter by status" });
    const activePill = filters.getByRole("button", {
      name: "Active",
      exact: true,
    });
    await expect(async () => {
      await activePill.click();
      await expect(activePill).toHaveAttribute("aria-pressed", "true", {
        timeout: 2000,
      });
    }).toPass({ timeout: 30000 });
    await expect(expiredRow).toHaveCount(0);
    await expect(activeRow).toBeVisible();

    await filters.getByRole("button", { name: "Expired", exact: true }).click();
    await expect(activeRow).toHaveCount(0);
    await expect(expiredRow).toBeVisible();

    await filters.getByRole("button", { name: "All", exact: true }).click();
    await page.getByLabel("Search warranties").fill(active.name);
    await expect(expiredRow).toHaveCount(0);
    await expect(activeRow).toBeVisible();

    await activeRow
      .getByRole("button", { name: "Archive", exact: true })
      .click();
    await expect(activeRow).toHaveCount(0);

    await page.reload();
    await expect(expiredRow).toBeVisible();
    await expect(activeRow).toHaveCount(0);

    await page.getByRole("switch", { name: "Show archived" }).click();
    await expect(activeRow).toBeVisible();
    await expect(
      activeRow.getByRole("button", { name: "Unarchive", exact: true }),
    ).toBeVisible();
    await expect(expiredRow).toHaveCount(0);
  });

  test("imports a Warracker CSV after previewing its rows", async ({
    authedPage: page,
  }) => {
    const laptop = `Imported Laptop ${uniqueId()}`;
    const fridge = `Imported Fridge ${uniqueId()}`;
    const csv = [
      "ProductName,PurchaseDate,WarrantyDurationYears,WarrantyDurationMonths,WarrantyDurationDays,ExpirationDate,IsLifetime,PurchasePrice,SerialNumber,ProductURL,Vendor,Tags,Notes,Currency,ModelNumber,WarrantyType",
      `${laptop},${isoDaysFromToday(-30)},2,0,0,,false,1499.99,SN-${randomInt(100000, 999999)},,Best Buy,,,USD,X1,Manufacturer`,
      `${fridge},${isoDaysFromToday(-400)},0,0,0,${isoDaysFromToday(5 * 365)},false,,,,Home Depot,,,,,extended`,
    ].join("\n");

    await page.goto("/warranties");
    const dialog = page.getByRole("dialog", {
      name: "Import warranties from CSV",
    });
    await expect(async () => {
      await page
        .getByRole("button", { name: "Import CSV", exact: true })
        .click();
      await expect(dialog).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 30000 });

    await dialog.getByLabel("CSV file").setInputFiles({
      name: "warracker.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(csv, "utf8"),
    });

    // The preview is a dry run: both rows shown as ready, nothing saved yet.
    await expect(dialog.getByText("2 of 2 rows can be imported.")).toBeVisible({
      timeout: 15000,
    });
    await expect(dialog.locator("tr", { hasText: laptop })).toContainText(
      "Ready",
    );
    await expect(dialog.locator("tr", { hasText: fridge })).toContainText(
      "Ready",
    );
    await expect(
      page.locator("main").locator("tr", { hasText: laptop }),
    ).toHaveCount(0);

    await dialog
      .getByRole("button", { name: "Import 2 warranties", exact: true })
      .click();
    await expect(dialog).toHaveCount(0);

    const list = page.locator("main");
    await expect(list.locator("tr", { hasText: laptop })).toBeVisible();
    await expect(list.locator("tr", { hasText: fridge })).toBeVisible();
    await page.reload();
    await expect(list.locator("tr", { hasText: laptop })).toBeVisible();
    await expect(list.locator("tr", { hasText: fridge })).toBeVisible();
  });
});
