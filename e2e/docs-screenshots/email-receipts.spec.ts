import {
  test,
  expect,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { apiFor, waitForReady } from "../readme/session";
import { csrfToken, type ApiClient } from "../helpers/api";
import { addDays, STATE_FILE } from "../readme/settings";
import { loadTransactions, type TransactionRow } from "../readme/seed-lookup";
import { docShot, openDocsSession } from "./capture";

// website/docs/email-receipts.md. The demo data has no mailbox and no emails,
// and no real mailbox is reachable from the stack. So this file gives the demo
// user a mailbox that is never polled (automatic reading off, an app password
// that signs in nowhere), one profile for Best Buy's order emails, and four
// order confirmations imported as .eml files, the way "Import archived emails"
// does: a Best Buy order the profile reads and matches, an Amazon.ca order read
// from the schema.org data in its HTML, an IKEA order no profile reads, and a
// Best Buy order no transaction pays. The emails are written from the demo
// register's own purchases, so the proposals match on any demo instance.
// Everything is looked up first: the mailbox and profile are created once, and
// an email already imported (by its Message-ID) is not stored again. Nothing is
// approved, linked or saved through a dialog, so no demo transaction changes.

// A first visit to a route compiles it on the development server: minutes, not seconds.
test.describe.configure({ timeout: 360_000 });

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  context = await openDocsSession(browser);
  page = await context.newPage();
  await page.goto("/dashboard");
  await seedReceipts(page);
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

const PROFILE = "Best Buy order confirmations";
/** The notices these emails raise. */
const RECEIPT_NOTICES = [
  "EMAIL_RECEIPTS_ATTENTION",
  "AI_REVIEW_PROPOSALS_READY",
];
const BEST_BUY_SUBJECT = "Thanks for your order BBY01-806514392817";
const UNMATCHED_SUBJECT = "Thanks for your order BBY01-806519920455";
const IKEA_SUBJECT = "Your IKEA order confirmation 1187342290";
const AMAZON_SUBJECT = "Your Amazon.ca order #702-4410928-5530617";

interface Named {
  id: string;
  name: string;
}

const money = (n: number) => n.toFixed(2);
const cents = (n: number) => Math.round(n * 100) / 100;
const rfcDate = (ymd: string, time: string) =>
  new Date(`${ymd}T${time}Z`).toUTCString().replace("GMT", "+0000");

/** One order confirmation as an RFC 822 message: a text part, and an HTML part when given. */
function eml(mail: {
  from: string;
  subject: string;
  date: string;
  id: string;
  text: string;
  html?: string;
}): Buffer {
  const boundary = "MONIZE-DOCS-BOUNDARY";
  const parts = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    mail.text,
  ];
  if (mail.html) {
    parts.push(
      `--${boundary}`,
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
      "",
      mail.html,
    );
  }
  parts.push(`--${boundary}--`, "");
  const lines = [
    `From: ${mail.from}`,
    "To: receipts.demo@gmail.com",
    `Subject: ${mail.subject}`,
    `Date: ${mail.date}`,
    `Message-ID: <${mail.id}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    ...parts,
  ];
  return Buffer.from(lines.join("\r\n"), "utf8");
}

/** The newest purchase from `payee` (in `categoryId` when given), never a split or transfer. */
function newest(
  rows: TransactionRow[],
  payee: string,
  categoryId: string | null,
): TransactionRow {
  const found = rows
    .filter(
      (r) =>
        r.payeeName === payee &&
        !r.isSplit &&
        !r.isTransfer &&
        Number(r.amount) < 0 &&
        (categoryId === null || r.categoryId === categoryId),
    )
    .sort((a, b) => b.transactionDate.localeCompare(a.transactionDate))[0];
  if (!found) throw new Error(`The demo register has no ${payee} purchase.`);
  return found;
}

function bestBuyMail(row: TransactionRow): Buffer {
  const total = Math.abs(Number(row.amount));
  const headphones = cents(total * 0.87);
  const caseLine = cents(total - headphones);
  return eml({
    from: "Best Buy <noreply@bestbuy.ca>",
    subject: BEST_BUY_SUBJECT,
    date: rfcDate(row.transactionDate, "19:41:00"),
    id: "docs-bestbuy-806514392817@monize.example",
    text: [
      "Thanks for your order, Demo!",
      "",
      "Order number: BBY01-806514392817",
      `Order date: ${row.transactionDate}`,
      "",
      "Items in this order",
      `1 x Sony WH-1000XM5 Wireless Noise Cancelling Headphones $${money(headphones)}`,
      `1 x Insignia Hard Shell Headphone Case $${money(caseLine)}`,
      "",
      `Order total: $${money(total)}`,
      "Prices include HST.",
      "",
      "Best Buy Canada",
    ].join("\n"),
  });
}

function unmatchedMail(): Buffer {
  const day = addDays(new Date().toISOString().slice(0, 10), -4);
  return eml({
    from: "Best Buy <noreply@bestbuy.ca>",
    subject: UNMATCHED_SUBJECT,
    date: rfcDate(day, "20:17:00"),
    id: "docs-bestbuy-806519920455@monize.example",
    text: [
      "Thanks for your order, Demo!",
      "",
      "Order number: BBY01-806519920455",
      `Order date: ${day}`,
      "",
      "Items in this order",
      "1 x Logitech MX Master 3S Wireless Mouse $129.99",
      "",
      "Order total: $129.99",
      "Prices include HST.",
      "",
      "Best Buy Canada",
    ].join("\n"),
  });
}

function amazonMail(row: TransactionRow): Buffer {
  const total = Math.abs(Number(row.amount));
  const powerBank = cents(total * 0.62);
  const cable = cents(total - powerBank);
  const items: [string, number][] = [
    ["Anker 737 Power Bank (24,000 mAh)", powerBank],
    ["USB-C to USB-C cable, 2 m (2-pack)", cable],
  ];
  const order = {
    "@context": "https://schema.org",
    "@type": "Order",
    merchant: { "@type": "Organization", name: "Amazon.ca" },
    orderNumber: "702-4410928-5530617",
    priceCurrency: "CAD",
    price: money(total),
    orderDate: row.transactionDate,
    acceptedOffer: items.map(([name, price]) => ({
      "@type": "Offer",
      itemOffered: { "@type": "Product", name },
      price: money(price),
      priceCurrency: "CAD",
      eligibleQuantity: { "@type": "QuantitativeValue", value: 1 },
    })),
  };
  const rows = items.map(
    ([name, price]) => `<tr><td>${name}</td><td>$${money(price)}</td></tr>`,
  );
  return eml({
    from: "Amazon.ca <auto-confirm@amazon.ca>",
    subject: AMAZON_SUBJECT,
    date: rfcDate(row.transactionDate, "14:12:00"),
    id: "docs-amazon-702-4410928-5530617@monize.example",
    text: [
      "Hello Demo,",
      "",
      "Thank you for shopping with us. Your order 702-4410928-5530617 has been placed.",
      "",
      ...items.map(([name, price]) => `${name}  $${money(price)}`),
      "",
      `Order total: $${money(total)}`,
    ].join("\n"),
    html:
      `<html><head><script type="application/ld+json">${JSON.stringify(order)}</script></head>` +
      "<body><p>Hello Demo,</p><p>Thank you for shopping with us.</p><table>" +
      rows.join("") +
      `<tr><td><b>Order total</b></td><td><b>$${money(total)}</b></td></tr></table></body></html>`,
  });
}

function ikeaMail(row: TransactionRow): Buffer {
  return eml({
    from: "IKEA Canada <no-reply@order.ikea.ca>",
    subject: IKEA_SUBJECT,
    date: rfcDate(row.transactionDate, "16:05:00"),
    id: "docs-ikea-1187342290@monize.example",
    text: [
      "Hej Demo,",
      "",
      "Thank you for your order 1187342290.",
      "",
      "VARIERA Pot lid organizer, bamboo  1 pc",
      "KUNGSFORS Rail, stainless steel  2 pcs",
      "RINNIG Dish drainer, white  1 pc",
      "",
      `Total incl. taxes: CAD ${money(Math.abs(Number(row.amount)))}`,
      "",
      "IKEA Canada",
    ].join("\n"),
  });
}

async function importEmail(
  p: Page,
  name: string,
  buffer: Buffer,
): Promise<void> {
  const token = await csrfToken(p.request);
  const res = await p.request.post("/api/v1/email-receipts/mailbox/import", {
    headers: token ? { "X-CSRF-Token": token } : {},
    multipart: { files: { name, mimeType: "message/rfc822", buffer } },
    timeout: 120_000,
  });
  if (!res.ok())
    throw new Error(
      `Importing ${name} failed (${res.status()}): ${await res.text()}`,
    );
}

async function seedReceipts(p: Page): Promise<void> {
  const api: ApiClient = apiFor(p);

  // A mailbox that is never polled: imports need one, and its settings are on the Mailbox tab.
  const mailbox = await p.request.get("/api/v1/email-receipts/mailbox");
  if (!(await mailbox.text()).trim()) {
    await api.put("/email-receipts/mailbox", {
      host: "imap.gmail.com",
      port: 993,
      security: "tls",
      username: "receipts.demo@gmail.com",
      password: "abcd efgh ijkl mnop",
      folder: "Receipts",
      enabled: false,
      aiMode: "on_demand",
      autoApply: false,
    });
  }

  const [payees, categories, rows] = await Promise.all([
    api.get<Named[]>("/payees"),
    api.get<Named[]>("/categories"),
    loadTransactions(api),
  ]);
  const electronics =
    categories.find((c) => c.name === "Electronics")?.id ?? null;
  const bestBuy = payees.find((x) => x.name === "Best Buy")?.id ?? null;

  const profiles = await api.get<Named[]>("/email-receipt-parsers");
  if (!profiles.some((x) => x.name === PROFILE)) {
    await api.post("/email-receipt-parsers", {
      name: PROFILE,
      payeeId: bestBuy,
      fromDomains: ["bestbuy.ca"],
      subjectContains: ["Thanks for your order"],
      definition: {
        version: 2,
        source: "text",
        orderId: ["Order number: {orderid}"],
        total: ["Order total: ${amount}"],
        items: {
          startAfter: "Items in this order",
          stopAt: "Order total",
          patterns: ["{qty} x {name} ${amount}"],
        },
        ...(electronics ? { defaultCategoryId: electronics } : {}),
      },
    });
  }

  await importEmail(
    p,
    "bestbuy-order.eml",
    bestBuyMail(newest(rows, "Best Buy", electronics)),
  );
  await importEmail(
    p,
    "amazon-order.eml",
    amazonMail(newest(rows, "Amazon.ca", electronics)),
  );
  await importEmail(p, "ikea-order.eml", ikeaMail(newest(rows, "IKEA", null)));
  await importEmail(p, "bestbuy-mouse.eml", unmatchedMail());

  // The IKEA email raises "Email receipts need attention" in the bell, and the
  // waiting proposals "AI review proposals wait for you". Read them, so the
  // badge in every other picture stays as the demo data left it.
  const notifications = await api.get<
    { id: string; type: string; isRead: boolean }[]
  >("/notifications?limit=50");
  for (const n of notifications) {
    if (RECEIPT_NOTICES.includes(n.type) && !n.isRead) {
      await api.patch(`/notifications/${n.id}/read`);
    }
  }
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

/** A taller window for the dialogs that scroll inside a 1000-pixel one. */
const TALL = { width: 1600, height: 1500 };

test.afterEach(async () => {
  await saveSession();
  await page.keyboard.press("Escape");
  await page.setViewportSize({ width: 1600, height: 1000 });
});

const hub = (tab: string) => go(page, `/email-receipts?tab=${tab}`);
const emailRow = (subject: string) =>
  page.getByRole("row").filter({ hasText: subject }).first();

test("email-receipts-overview", async () => {
  await hub("overview");
  await expect(
    page.getByRole("heading", { name: "Senders without a profile" }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await waitForReady(page);
  await docShot(page, "email-receipts-overview");
});

test("email-receipts-mailbox", async () => {
  await hub("mailbox");
  await expect(page.getByLabel("IMAP server")).toHaveValue("imap.gmail.com", {
    timeout: 30_000,
  });
  await waitForReady(page);
  await docShot(page, "email-receipts-mailbox");
});

test("email-receipts-import", async () => {
  await hub("mailbox");
  const card = page.getByRole("region", { name: "Import archived emails" });
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card
    .getByRole("button", { name: "How to export emails from your provider" })
    .click();
  await card.scrollIntoViewIfNeeded();
  await waitForReady(page);
  await docShot(page, "email-receipts-import", card);
});

test("email-receipts-emails", async () => {
  await hub("emails");
  await expect(emailRow(BEST_BUY_SUBJECT)).toBeVisible({ timeout: 30_000 });
  await expect(emailRow(IKEA_SUBJECT)).toBeVisible();
  await waitForReady(page);
  await docShot(page, "email-receipts-emails");
});

test("email-receipts-email-detail", async () => {
  await page.setViewportSize(TALL);
  await hub("emails");
  await emailRow(BEST_BUY_SUBJECT)
    .getByRole("button", { name: "View", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByText("Sony WH-1000XM5", { exact: false }).first(),
  ).toBeVisible({
    timeout: 30_000,
  });
  await waitForReady(page);
  await docShot(page, "email-receipts-email-detail", dialog);
});

test("email-receipts-choose-transaction", async () => {
  await page.setViewportSize(TALL);
  await hub("emails");
  await emailRow(UNMATCHED_SUBJECT)
    .getByRole("button", { name: "Choose transaction", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await waitForReady(page);
  await docShot(page, "email-receipts-choose-transaction", dialog);
});

test("email-receipts-profiles", async () => {
  await hub("profiles");
  await expect(page.getByRole("row").filter({ hasText: PROFILE })).toBeVisible({
    timeout: 30_000,
  });
  await waitForReady(page);
  await docShot(page, "email-receipts-profiles");
});

test("email-receipts-profile-editor", async () => {
  await page.setViewportSize(TALL);
  await hub("profiles");
  await page
    .getByRole("row")
    .filter({ hasText: PROFILE })
    .getByRole("button", { name: "Edit", exact: true })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Name", { exact: true }).first()).toHaveValue(
    PROFILE,
    {
      timeout: 30_000,
    },
  );
  await waitForReady(page);
  await docShot(page, "email-receipts-profile-editor", dialog);
});

test("email-receipts-profile-wizard", async () => {
  await go(page, "/email-receipts?tab=profiles&wizard=order.ikea.ca");
  const profiles = page.getByRole("region", { name: "Profiles" });
  await expect(
    profiles.getByRole("heading", {
      name: "Create a profile for order.ikea.ca",
    }),
  ).toBeVisible({
    timeout: 30_000,
  });
  await expect(profiles.getByText(IKEA_SUBJECT).first()).toBeVisible();
  await waitForReady(page);
  await docShot(page, "email-receipts-profile-wizard", profiles);
});

test("email-receipts-review-inbox", async () => {
  await go(page, "/ai-reviews?kind=email_receipt");
  await expect(
    page.getByText(new RegExp(BEST_BUY_SUBJECT)).first(),
  ).toBeVisible({
    timeout: 30_000,
  });
  await waitForReady(page);
  await docShot(page, "email-receipts-review-inbox");
});
