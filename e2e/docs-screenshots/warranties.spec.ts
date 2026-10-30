import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { apiFor, open, waitForReady } from "../readme/session";
import { csrfToken, type ApiClient } from "../helpers/api";
import { addDays, STATE_FILE } from "../readme/settings";
import { loadTransactions, type TransactionRow } from "../readme/seed-lookup";
import { cardOf, docShot, openDocsSession } from "./capture";

// website/docs/warranties.md. The demo data has no warranties, so this file
// adds six to it through the API, each tied to a purchase already in the demo
// register where there is one: headphones and a monitor from Best Buy, an
// e-reader and a Dutch oven from Amazon.ca, kitchen cabinets from IKEA, and a
// vacuum bought before the ledger starts. They span every status (active,
// expiring soon, expired, lifetime). Each is looked up by name first and
// created only when missing, with its documents and claims, so the second
// theme's run and every later run change nothing. No dialog is saved.

// A first visit to a route compiles it on the development server: minutes, not seconds.
test.describe.configure({ timeout: 360_000 });

let context: BrowserContext;
let page: Page;
let seeded: Seeded;

test.beforeAll(async ({ browser }) => {
  context = await openDocsSession(browser);
  page = await context.newPage();
  await page.goto("/dashboard");
  seeded = await seedWarranties(page, browser);
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

const HEADPHONES = "Sony WH-1000XM5 headphones";

interface Named {
  id: string;
  name: string;
}

interface WarrantyRow extends Named {
  documentCount: number;
  vendorName: string | null;
}

interface Seeded {
  headphones: WarrantyRow;
  headphonesPurchase: TransactionRow;
  /** A demo purchase with no warranty yet, for the "add one from a transaction" pictures. */
  unclaimedPurchase: TransactionRow;
}

const today = () => new Date().toISOString().slice(0, 10);

/** The newest row of `payee` in `category` on or before `onOrBefore`, never a split or transfer. */
function purchase(
  rows: TransactionRow[],
  payee: string,
  categoryId: string | null,
  onOrBefore: string,
): TransactionRow {
  const found = rows
    .filter(
      (r) =>
        r.payeeName === payee &&
        !r.isSplit &&
        !r.isTransfer &&
        Number(r.amount) < 0 &&
        (categoryId === null || r.categoryId === categoryId) &&
        r.transactionDate <= onOrBefore,
    )
    .sort((a, b) => b.transactionDate.localeCompare(a.transactionDate))[0];
  if (!found)
    throw new Error(
      `The demo register has no ${payee} purchase on or before ${onOrBefore}.`,
    );
  return found;
}

/** A taller window for the dialogs that scroll inside a 1000-pixel one. */
const TALL = { width: 1600, height: 1500 };

test.afterEach(async () => {
  await saveSession();
  await page.setViewportSize({ width: 1600, height: 1000 });
});

const top = () => page.evaluate(() => window.scrollTo(0, 0));

const price = (row: TransactionRow) => Math.abs(Number(row.amount));

/** A paper receipt, drawn in a throwaway page, as PNG bytes. */
async function receiptPng(
  browser: Browser,
  lines: string[][],
  total: string,
): Promise<Buffer> {
  const rows = lines
    .map(
      ([l, r]) => `<div class="row"><span>${l}</span><span>${r}</span></div>`,
    )
    .join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; background: #d8d4cc; font-family: "DejaVu Sans Mono", "Courier New", monospace; }
    .paper { width: 380px; margin: 24px auto; padding: 26px 28px 22px; background: #fdfcf8; color: #222; font-size: 13px; line-height: 1.55; box-shadow: 0 2px 10px rgba(0,0,0,.25); }
    h1 { font-size: 18px; margin: 0; text-align: center; letter-spacing: 1px; }
    .sub { text-align: center; color: #555; font-size: 11px; margin-bottom: 14px; }
    .row { display: flex; justify-content: space-between; gap: 12px; }
    hr { border: 0; border-top: 1px dashed #888; margin: 10px 0; }
    .total { font-weight: bold; font-size: 15px; }
  </style></head><body><div class="paper">
    <h1>BEST BUY</h1><div class="sub">Store 937 &middot; Toronto Eaton Centre<br>Sales receipt &middot; Keep for warranty service</div>
    ${rows}<hr><div class="row total"><span>TOTAL CAD</span><span>${total}</span></div>
    <div class="row"><span>Paid by</span><span>VISA ****4417</span></div>
  </div></body></html>`;
  const ctx = await browser.newContext({
    viewport: { width: 440, height: 100 },
    deviceScaleFactor: 2,
  });
  try {
    const p = await ctx.newPage();
    await p.setContent(html);
    return await p.screenshot({ type: "png", fullPage: true });
  } finally {
    await ctx.close();
  }
}

/** A one-page product manual as a PDF, printed by Chromium from local HTML. */
async function manualPdf(
  browser: Browser,
  title: string,
  body: string,
): Promise<Buffer> {
  const ctx = await browser.newContext();
  try {
    const p = await ctx.newPage();
    await p.setContent(
      `<!doctype html><html><body style="font-family: sans-serif; padding: 48px;"><h1>${title}</h1>${body}</body></html>`,
    );
    return await p.pdf({ format: "A4" });
  } finally {
    await ctx.close();
  }
}

async function upload(
  p: Page,
  warrantyId: string,
  file: { name: string; mimeType: string; buffer: Buffer },
  documentKind: string,
): Promise<void> {
  const token = await csrfToken(p.request);
  const res = await p.request.post(
    `/api/v1/warranties/${warrantyId}/attachments`,
    {
      headers: token ? { "X-CSRF-Token": token } : {},
      multipart: { file, documentKind },
    },
  );
  if (!res.ok())
    throw new Error(
      `Uploading ${file.name} failed (${res.status()}): ${await res.text()}`,
    );
}

async function findWarranty(
  api: ApiClient,
  name: string,
): Promise<WarrantyRow | undefined> {
  for (const archived of [false, true]) {
    const res = await api.get<{ data: WarrantyRow[] }>(
      `/warranties?q=${encodeURIComponent(name)}&archived=${archived}&limit=50`,
    );
    const hit = res.data.find((w) => w.name === name);
    if (hit) return hit;
  }
  return undefined;
}

async function ensureWarranty(
  api: ApiClient,
  body: Record<string, unknown>,
): Promise<WarrantyRow> {
  const name = body.name as string;
  const found = await findWarranty(api, name);
  if (found) {
    // An earlier run created it without the vendor's name beside the payee.
    if (body.vendorName !== undefined && found.vendorName !== body.vendorName) {
      await api.patch(`/warranties/${found.id}`, {
        vendorName: body.vendorName,
      });
    }
    return found;
  }
  await api.post("/warranties", body);
  const created = await findWarranty(api, name);
  if (!created) throw new Error(`The warranty "${name}" was not created.`);
  return created;
}

async function ensureClaims(
  api: ApiClient,
  warrantyId: string,
  claims: Record<string, unknown>[],
): Promise<void> {
  const existing = await api.get<unknown[]>(`/warranties/${warrantyId}/claims`);
  if (existing.length > 0) return;
  for (const claim of claims)
    await api.post(`/warranties/${warrantyId}/claims`, claim);
}

async function seedWarranties(p: Page, browser: Browser): Promise<Seeded> {
  const api = apiFor(p);
  const [payees, categories, rows] = await Promise.all([
    api.get<Named[]>("/payees"),
    api.get<Named[]>("/categories"),
    loadTransactions(api),
  ]);
  const payeeId = (name: string) =>
    payees.find((x) => x.name === name)?.id ?? null;
  const categoryId = (name: string) =>
    categories.find((x) => x.name === name)?.id ?? null;
  const electronics = categoryId("Electronics");
  const now = today();

  const headphonesPurchase = purchase(rows, "Best Buy", electronics, now);
  const monitorPurchase = purchase(
    rows,
    "Best Buy",
    electronics,
    addDays(now, -330),
  );
  const ereaderPurchase = purchase(
    rows,
    "Amazon.ca",
    electronics,
    addDays(now, -200),
  );
  const ovenPurchase = purchase(
    rows,
    "Amazon.ca",
    categoryId("Home Goods"),
    now,
  );
  const cabinetsPurchase = purchase(rows, "IKEA", null, now);
  const unclaimedPurchase = purchase(rows, "Amazon.ca", electronics, now);

  const headphones = await ensureWarranty(api, {
    name: HEADPHONES,
    payeeId: payeeId("Best Buy"),
    vendorName: "Best Buy",
    transactionId: headphonesPurchase.id,
    modelNumber: "WH-1000XM5/B",
    serialNumbers: ["5214837"],
    warrantyKind: "manufacturer",
    purchaseDate: headphonesPurchase.transactionDate,
    term: { years: 1 },
    purchasePrice: price(headphonesPurchase),
    currencyCode: "CAD",
    productUrl:
      "https://www.sony.ca/en/electronics/headband-headphones/wh-1000xm5",
    notes: "Registered with Sony. Keep the box until the warranty ends.",
  });
  if (headphones.documentCount === 0) {
    const total = price(headphonesPurchase).toFixed(2);
    await upload(
      p,
      headphones.id,
      {
        name: "best-buy-receipt.png",
        mimeType: "image/png",
        buffer: await receiptPng(
          browser,
          [
            ["Sony WH-1000XM5", ""],
            ["  SKU 16224387  S/N 5214837", ""],
            ["Headphones", total],
          ],
          total,
        ),
      },
      "receipt",
    );
    await upload(
      p,
      headphones.id,
      {
        name: "wh-1000xm5-help-guide.pdf",
        mimeType: "application/pdf",
        buffer: await manualPdf(
          browser,
          "WH-1000XM5 Help Guide",
          "<p>Charging, pairing, noise cancelling and the limited warranty.</p><p>Limited warranty: one year from the date of purchase, parts and labour.</p>",
        ),
      },
      "manual",
    );
  }
  await ensureClaims(api, headphones.id, [
    {
      claimDate: addDays(headphonesPurchase.transactionDate, 52),
      status: "resolved",
      description: "The left ear cup crackles at high volume.",
      resolution: "Sony replaced the left ear cup under warranty.",
      resolvedOn: addDays(headphonesPurchase.transactionDate, 66),
    },
    {
      claimDate: addDays(now, -6),
      status: "open",
      description:
        "The case zip broke. Asked Best Buy whether the store warranty covers it.",
    },
  ]);

  await ensureWarranty(api, {
    name: "Samsung 27-inch monitor",
    payeeId: payeeId("Best Buy"),
    vendorName: "Best Buy",
    transactionId: monitorPurchase.id,
    modelNumber: "LS27C330GANXZA",
    serialNumbers: ["0Z4FHCNX200731"],
    warrantyKind: "manufacturer",
    purchaseDate: monitorPurchase.transactionDate,
    expiresOn: addDays(now, 12),
    purchasePrice: price(monitorPurchase),
    currencyCode: "CAD",
  });

  const ereader = await ensureWarranty(api, {
    name: "Kobo Clara BW e-reader",
    payeeId: payeeId("Amazon.ca"),
    vendorName: "Amazon.ca",
    transactionId: ereaderPurchase.id,
    modelNumber: "N365",
    warrantyKind: "store",
    purchaseDate: ereaderPurchase.transactionDate,
    term: { months: 6 },
    purchasePrice: price(ereaderPurchase),
    currencyCode: "CAD",
  });
  await ensureClaims(api, ereader.id, [
    {
      claimDate: addDays(ereaderPurchase.transactionDate, 40),
      status: "denied",
      description: "The screen cracked in a backpack.",
      resolution: "Denied: accidental damage is not covered.",
      resolvedOn: addDays(ereaderPurchase.transactionDate, 47),
    },
  ]);

  await ensureWarranty(api, {
    name: "Le Creuset Dutch oven",
    payeeId: payeeId("Amazon.ca"),
    vendorName: "Amazon.ca",
    transactionId: ovenPurchase.id,
    modelNumber: "21177",
    warrantyKind: "manufacturer",
    purchaseDate: ovenPurchase.transactionDate,
    isLifetime: true,
    purchasePrice: price(ovenPurchase),
    currencyCode: "CAD",
    notes: "Lifetime warranty against manufacturing defects.",
  });

  await ensureWarranty(api, {
    name: "IKEA METOD kitchen cabinets",
    payeeId: payeeId("IKEA"),
    vendorName: "IKEA",
    transactionId: cabinetsPurchase.id,
    warrantyKind: "manufacturer",
    purchaseDate: cabinetsPurchase.transactionDate,
    term: { years: 25 },
    purchasePrice: price(cabinetsPurchase),
    currencyCode: "CAD",
    productUrl:
      "https://www.ikea.com/ca/en/customer-service/returns-claims/guarantees/",
  });

  await ensureWarranty(api, {
    name: "Dyson V12 Detect vacuum",
    vendorName: "Hudson’s Bay",
    modelNumber: "SV20",
    serialNumbers: ["X4K-CA-PMA1832A"],
    warrantyKind: "extended",
    purchaseDate: addDays(now, -560),
    term: { years: 3 },
    purchasePrice: 749.99,
    currencyCode: "CAD",
    notes:
      "Extended protection plan bought at the till. Bought before this ledger starts.",
  });

  // The monitor that expires within the month raises a reminder in the bell
  // the next morning. Read it, so the badge in every other picture stays as the
  // demo data left it.
  const notifications = await api.get<
    { id: string; type: string; isRead: boolean }[]
  >("/notifications?limit=50");
  for (const n of notifications) {
    if (n.type.startsWith("WARRANTY_") && !n.isRead)
      await api.patch(`/notifications/${n.id}/read`);
  }

  return { headphones, headphonesPurchase, unclaimedPurchase };
}

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

test("warranties-list", async () => {
  await go(page, "/warranties");
  await expect(
    page.getByRole("row", { name: new RegExp(HEADPHONES) }),
  ).toBeVisible();
  await expect(
    page.getByRole("group", { name: "Filter by status" }),
  ).toBeVisible();
  await docShot(page, "warranties-list");
});

/** The detail page of the headphones, with its documents listed. */
async function openHeadphones(): Promise<void> {
  await go(
    page,
    `/warranties/${seeded.headphones.id}`,
    page.getByRole("heading", { name: HEADPHONES, level: 1 }),
  );
  const documents = page.getByRole("region", { name: "Documents" });
  await expect(documents.getByText("best-buy-receipt.png")).toBeVisible({
    timeout: 30_000,
  });
  await expect(documents.getByText("wh-1000xm5-help-guide.pdf")).toBeVisible();
  await waitForReady(page);
}

test("warranties-detail", async () => {
  await openHeadphones();
  await top();
  await docShot(page, "warranties-detail");
});

test("warranties-documents", async () => {
  await openHeadphones();
  const documents = page.getByRole("region", { name: "Documents" });
  await documents.scrollIntoViewIfNeeded();
  await docShot(page, "warranties-documents", documents);
});

test("warranties-claims", async () => {
  await openHeadphones();
  const claims = page.getByRole("region", { name: "Claims" });
  await expect(
    claims.getByText("The left ear cup crackles at high volume."),
  ).toBeVisible();
  await claims.scrollIntoViewIfNeeded();
  await docShot(page, "warranties-claims", claims);
});

test("warranties-claim-dialog", async () => {
  await openHeadphones();
  await page
    .getByRole("region", { name: "Claims" })
    .getByRole("button", { name: "Add claim" })
    .click();
  const dialog = page.getByRole("dialog", { name: "New claim" });
  await expect(dialog).toBeVisible();
  await dialog
    .getByLabel("Description")
    .fill("The battery no longer lasts a full day.");
  await docShot(page, "warranties-claim-dialog", dialog);
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("warranties-add-from-transaction", async () => {
  await page.setViewportSize(TALL);
  await go(
    page,
    `/warranties?new=1&transactionId=${seeded.unclaimedPurchase.id}`,
  );
  const dialog = page.getByRole("dialog", { name: "New warranty" });
  await expect(dialog.getByLabel("Purchase price")).not.toHaveValue("", {
    timeout: 30_000,
  });
  await dialog.getByLabel("Name", { exact: true }).fill("Anker 737 power bank");
  await dialog.getByLabel("Model number").fill("A1289");
  await expect(
    dialog.getByText(/^Expires on \d{4}-\d{2}-\d{2}$/),
  ).toBeVisible();
  await docShot(page, "warranties-add-from-transaction", dialog);
});

test("warranties-transaction-form", async () => {
  await page.setViewportSize(TALL);
  const purchase = seeded.headphonesPurchase;
  const amount = Math.abs(Number(purchase.amount)).toFixed(2);
  await go(page, `/transactions?targetTransactionId=${purchase.id}`);
  const row = page
    .locator("tr", { hasText: "Best Buy" })
    .filter({ hasText: amount })
    .first();
  const dialog = page.getByRole("dialog");
  await expect(async () => {
    await row.getByText(amount).first().click();
    await expect(dialog).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 60_000 });
  await expect(
    dialog.getByRole("link", { name: new RegExp(HEADPHONES) }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(dialog.getByText("best-buy-receipt.png")).toBeVisible({
    timeout: 30_000,
  });
  await waitForReady(page);
  await docShot(page, "warranties-transaction-form", dialog);
  await page.keyboard.press("Escape");
});

test("warranties-import-preview", async () => {
  await go(page, "/warranties");
  const dialog = page.getByRole("dialog", {
    name: "Import warranties from CSV",
  });
  await expect(async () => {
    await page.getByRole("button", { name: "Import CSV", exact: true }).click();
    await expect(dialog).toBeVisible({ timeout: 3000 });
  }).toPass({ timeout: 60_000 });
  const csv = [
    "ProductName,PurchaseDate,WarrantyDurationYears,WarrantyDurationMonths,WarrantyDurationDays,ExpirationDate,IsLifetime,PurchasePrice,SerialNumber,ProductURL,Vendor,Tags,Notes,Currency,ModelNumber,WarrantyType",
    "Bosch dishwasher,2024-05-14,2,0,0,,false,1149.00,FD9804-118,,Home Depot,kitchen,,CAD,SHX78CM5N,Manufacturer",
    'Garmin Forerunner 265,2025-03-02,,,,2027-03-02,false,599.99,"3QK091822, 3QK091823",,Sport Chek,,Two watches,CAD,010-02810-00,store',
    "Patio heater,2023-09-30,,,,,,,,,,,,,,",
  ].join("\n");
  await dialog.getByLabel("CSV file", { exact: true }).setInputFiles({
    name: "warracker-export.csv",
    mimeType: "text/csv",
    buffer: Buffer.from(csv, "utf8"),
  });
  await expect(dialog.getByText("2 of 3 rows can be imported.")).toBeVisible({
    timeout: 30_000,
  });
  await docShot(page, "warranties-import-preview", dialog);
  await page.keyboard.press("Escape");
});

test("warranties-reminder-settings", async () => {
  await go(page, "/settings#notifications");
  const heading = page.getByRole("heading", { name: "How to notify me" });
  await expect(heading).toBeVisible({ timeout: 30_000 });
  const card = cardOf(heading);
  await expect(card.getByText("Warranty reminders")).toBeVisible();
  await waitForReady(page);
  await card.scrollIntoViewIfNeeded();
  await docShot(page, "warranties-reminder-settings", card);
});
