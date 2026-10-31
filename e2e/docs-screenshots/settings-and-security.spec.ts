import {
  test,
  expect,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import {
  apiFor,
  dismissNotificationPrompt,
  open,
  waitForReady,
} from "../readme/session";
import { DESKTOP_CONTEXT, DESKTOP_VIEWPORT } from "../readme/settings";
import { loginUser } from "../helpers/auth";
import { rawApiRequest } from "../helpers/api";
import { E2E_DEFAULT_PASSWORD } from "../helpers/credentials";
import { generateTotp } from "../helpers/totp";
import {
  cardOf,
  docShot,
  openAdminSession,
  openDocsSession,
  theme,
} from "./capture";

// website/docs/settings-and-security.md. The demo user's settings are
// photographed as they are; dialogs are opened, photographed and cancelled.
// Two-factor authentication is never touched on the demo user or the admin:
// its pictures use a documentation user of their own (SECURITY_USER), whose
// 2FA the admin resets before each run so the run can enable it again.

const SECURITY_USER = {
  email: "alex.morgan@monize.example",
  firstName: "Alex",
  lastName: "Morgan",
  password: E2E_DEFAULT_PASSWORD,
};

interface AdminUserRow {
  id: string;
  email: string | null;
}

/** The documentation user's id, creating the account first if it does not exist yet. */
async function ensureUser(
  admin: Page,
  user: typeof SECURITY_USER,
): Promise<string> {
  const api = apiFor(admin);
  const users = await api.get<AdminUserRow[]>("/admin/users");
  const existing = users.find((u) => u.email === user.email);
  if (existing) return existing.id;
  const created = await api.post<{ user?: AdminUserRow; id?: string }>(
    "/admin/users",
    {
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      password: user.password,
      role: "user",
    },
  );
  const id = created.user?.id ?? created.id;
  if (!id) throw new Error("The admin API did not return the new user");
  return id;
}

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  context = await openDocsSession(browser);
  page = await context.newPage();
});

test.afterAll(async () => {
  await context.close();
});

/** The settings card under the level-2 heading `name`, scrolled into view. */
async function settingsCard(name: string): Promise<Locator> {
  await open(page, "/settings");
  // A card taller than the viewport is captured in pieces; the sticky app
  // header would otherwise be drawn across it.
  await page.addStyleTag({
    content: "header { position: static !important; }",
  });
  const heading = page.getByRole("heading", { name, level: 2, exact: true });
  await expect(heading).toBeVisible();
  const card = cardOf(heading);
  await card.scrollIntoViewIfNeeded();
  await waitForReady(page);
  return card;
}

test("settings-overview", async () => {
  await open(page, "/settings");
  await expect(
    page.getByRole("heading", { name: "Profile", level: 2 }),
  ).toBeVisible();
  await docShot(page, "settings-overview");
});

test("settings-profile", async () => {
  await docShot(page, "settings-profile", await settingsCard("Profile"));
});

test("settings-preferences", async () => {
  await docShot(
    page,
    "settings-preferences",
    await settingsCard("Preferences"),
  );
});

test("settings-notifications", async () => {
  await docShot(
    page,
    "settings-notifications",
    await settingsCard("Notifications"),
  );
});

test("settings-security", async () => {
  await docShot(page, "settings-security", await settingsCard("Security"));
});

test("settings-api-access", async () => {
  await docShot(page, "settings-api-access", await settingsCard("API Access"));
});

test("settings-api-token-dialog", async () => {
  const card = await settingsCard("API Access");
  await card.getByRole("button", { name: "Create Token" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Create API Token" }),
  ).toBeVisible();
  await dialog.getByLabel("Token Name").fill("Claude Desktop");
  await docShot(page, "settings-api-token-dialog", dialog);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
});

test("settings-payee-lookup", async () => {
  await docShot(
    page,
    "settings-payee-lookup",
    await settingsCard("Payee Lookup"),
  );
});

test("payee-lookup-google-places", async () => {
  const card = await settingsCard("Payee Lookup");
  await card.getByRole("button", { name: "Set up" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("API key")).toBeVisible();
  await docShot(page, "payee-lookup-google-places", dialog);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
});

test("settings-help", async () => {
  await docShot(page, "settings-help", await settingsCard("Help & Support"));
});

test("settings-support-backup", async () => {
  // Tall enough that the whole dialog shows without scrolling inside it.
  await page.setViewportSize({ width: 1600, height: 1800 });
  const card = await settingsCard("Help & Support");
  await card.getByRole("button", { name: /Create a support backup/ }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await waitForReady(page);
  await docShot(page, "settings-support-backup", dialog);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await page.setViewportSize(DESKTOP_VIEWPORT);
});

test("settings-about", async () => {
  const card = await settingsCard("About");
  await expect(card.getByText("Version", { exact: true })).toBeVisible();
  await docShot(page, "settings-about", card);
});

test("settings-danger-zone", async () => {
  await docShot(
    page,
    "settings-danger-zone",
    await settingsCard("Danger Zone"),
  );
});

test("settings-delete-data", async () => {
  // The confirmation opens inside the card; it is cancelled, never submitted.
  const card = await settingsCard("Danger Zone");
  await card.getByRole("button", { name: "Delete Data..." }).click();
  await expect(card.getByText("Optionally also delete:")).toBeVisible();
  await docShot(page, "settings-delete-data", card);
  await card.getByRole("button", { name: "Cancel" }).first().click();
  await expect(
    card.getByRole("button", { name: "Delete Data..." }),
  ).toBeVisible();
});

test("settings-guided-tours", async () => {
  await open(page, "/settings/tours");
  await expect(
    page.getByRole("heading", { name: "Guided tours", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start" }).first(),
  ).toBeVisible();
  await docShot(page, "settings-guided-tours");
});

test.describe("bank sync", () => {
  test("bank-sync-settings", async () => {
    await open(page, "/settings/bank-sync");
    await expect(
      page.getByRole("heading", { name: "Bank Sync", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", {
        name: "Enable Banking application",
        level: 2,
      }),
    ).toBeVisible();
    await docShot(page, "bank-sync-settings");
  });

  test("bank-sync-credentials-dialog", async () => {
    await open(page, "/settings/bank-sync");
    await page.getByRole("button", { name: "Set up credentials" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("Application ID")).toBeVisible();
    await docShot(page, "bank-sync-credentials-dialog", dialog);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  });

  test("bank-sync-simplefin", async () => {
    await open(page, "/settings/bank-sync");
    // The provider picker is a view filter; choosing one saves nothing.
    await page.getByLabel("Data provider").selectOption("simplefin");
    const card = cardOf(
      page.getByRole("button", { name: "Connect SimpleFIN" }),
    );
    await expect(card).toBeVisible();
    await waitForReady(page);
    await docShot(page, "bank-sync-simplefin", card);
  });
});

test.describe("two-factor authentication", () => {
  test.describe.configure({ mode: "serial", timeout: 300_000 });

  let security: BrowserContext;
  let secPage: Page;
  let secret = "";

  /** A fresh context for the documentation user, with nothing remembered. */
  async function freshContext(browser: Browser): Promise<BrowserContext> {
    return browser.newContext({ ...DESKTOP_CONTEXT, colorScheme: theme() });
  }

  test.beforeAll(async ({ browser }) => {
    // The admin creates the user once, and switches its 2FA off before each
    // run so the run can set it up again (400: it had none).
    const admin = await openAdminSession(browser);
    const adminPage = await admin.newPage();
    await adminPage.goto("/dashboard");
    const id = await ensureUser(adminPage, SECURITY_USER);
    const reset = await rawApiRequest(
      adminPage.request,
      "POST",
      `/admin/users/${id}/reset-2fa`,
    );
    expect([200, 201, 204, 400]).toContain(reset.status());
    await admin.close();

    security = await freshContext(browser);
    secPage = await security.newPage();
    await loginUser(secPage, SECURITY_USER.email, SECURITY_USER.password);
    await dismissNotificationPrompt(secPage);
    await apiFor(secPage).patch("/users/preferences", { theme: "system" });
  });

  test.afterAll(async () => {
    await security.close();
  });

  test("2fa-setup", async () => {
    await open(secPage, "/settings");
    const card = cardOf(
      secPage.getByRole("heading", { name: "Security", level: 2 }),
    );
    await card.getByRole("button", { name: "Enable 2FA" }).click();
    const dialog = secPage.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Confirm your password" }),
    ).toBeVisible();
    // Its label is tied by id to the Security section's own "Current Password"
    // field, so the dialog's field has no accessible name of its own.
    await dialog
      .locator('input[autocomplete="current-password"]')
      .fill(SECURITY_USER.password);
    await dialog.getByRole("button", { name: "Continue" }).click();
    await expect(
      dialog.getByRole("img", { name: "2FA QR Code" }),
    ).toBeVisible();
    await docShot(secPage, "2fa-setup", dialog);

    await dialog
      .getByRole("button", { name: "Can't scan? Enter key manually" })
      .click();
    secret = (
      await dialog
        .getByText("Manual entry key:")
        .locator("xpath=following-sibling::p[1]")
        .innerText()
    ).trim();
    expect(secret).toMatch(/^[A-Z2-7]+=*$/);
  });

  test("2fa-backup-codes", async () => {
    const dialog = secPage.getByRole("dialog");
    // A code typed in the last seconds of its 30-second window can expire in flight.
    await expect
      .poll(() => (Date.now() / 1000) % 30 < 20, { timeout: 15_000 })
      .toBe(true);
    await dialog
      .getByLabel("Enter the 6-digit code from your app")
      .fill(generateTotp(secret));
    await dialog.getByRole("button", { name: "Verify and Enable" }).click();
    await expect(
      dialog.getByRole("heading", { name: "Save Your Backup Codes" }),
    ).toBeVisible();
    await expect(
      secPage.locator('div[role="status"][aria-live="polite"]'),
    ).toHaveCount(0, {
      timeout: 15_000,
    });
    await docShot(secPage, "2fa-backup-codes", dialog);
    await dialog.getByRole("checkbox").check();
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();
  });

  test("2fa-login", async ({ browser }) => {
    // A new browser: signing in asks for the second factor, and "Don't ask
    // again" makes it a trusted device.
    await security.close();
    security = await freshContext(browser);
    secPage = await security.newPage();
    await secPage.goto("/login");
    await secPage.getByLabel(/email/i).fill(SECURITY_USER.email);
    await secPage.getByLabel(/password/i).fill(SECURITY_USER.password);
    await secPage.getByRole("button", { name: /sign in/i }).click();
    const code = secPage.getByLabel("Verification Code");
    await expect(code).toBeVisible();
    await secPage.getByRole("checkbox").check();
    // The sign-in screen has no <main>, so wait for its spinner instead.
    await expect(secPage.locator(".animate-spin")).toHaveCount(0);
    await docShot(secPage, "2fa-login");

    // The code from enabling 2FA is spent; wait for the next one.
    const first = generateTotp(secret);
    await expect
      .poll(() => generateTotp(secret), { timeout: 35_000 })
      .not.toBe(first);
    await expect
      .poll(() => (Date.now() / 1000) % 30 < 20, { timeout: 15_000 })
      .toBe(true);
    await code.fill(generateTotp(secret));
    await secPage.getByRole("button", { name: "Verify" }).click();
    await secPage.waitForURL(/\/dashboard/);
    await dismissNotificationPrompt(secPage);
  });

  test("settings-security-2fa", async () => {
    await open(secPage, "/settings");
    const heading = secPage.getByRole("heading", {
      name: "Security",
      level: 2,
    });
    await expect(
      secPage.getByRole("button", { name: "Disable 2FA" }),
    ).toBeVisible({
      timeout: 30_000,
    });
    await expect(
      secPage.getByRole("button", { name: "Revoke All" }),
    ).toBeVisible();
    const card = cardOf(heading);
    await card.scrollIntoViewIfNeeded();
    await docShot(secPage, "settings-security-2fa", card);
  });

  test("trusted-devices", async () => {
    const heading = secPage.getByRole("heading", { name: "Trusted Devices" });
    const section = heading.locator("xpath=ancestor::div[1]/..");
    await expect(
      section.getByRole("button", { name: "Revoke", exact: true }),
    ).toBeVisible();
    // The block has no padding of its own inside the card; give the crop some.
    await section.evaluate((el) => {
      el.style.padding = "24px";
      el.style.margin = "0 -24px";
    });
    await docShot(secPage, "trusted-devices", section);
  });
});

test.describe("admin", () => {
  let admin: BrowserContext;
  let adminPage: Page;

  test.beforeAll(async ({ browser }) => {
    admin = await openAdminSession(browser);
    adminPage = await admin.newPage();
    await adminPage.goto("/dashboard");
    await dismissNotificationPrompt(adminPage);
    await ensureUser(adminPage, SECURITY_USER);
  });

  test.afterAll(async () => {
    await admin.close();
  });

  test("admin-user-management", async () => {
    await open(adminPage, "/admin/users");
    await expect(
      adminPage.getByRole("heading", { name: "User Management", level: 1 }),
    ).toBeVisible();
    await expect(
      adminPage.getByRole("cell", { name: /Alex Morgan/ }),
    ).toBeVisible();
    await docShot(adminPage, "admin-user-management");
  });

  test("admin-add-user", async () => {
    await open(adminPage, "/admin/users");
    await adminPage.getByRole("button", { name: "+ New User" }).click();
    const dialog = adminPage.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Add User" }),
    ).toBeVisible();
    await docShot(adminPage, "admin-add-user", dialog);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  });

  test("admin-notifications", async () => {
    await open(adminPage, "/admin/notifications");
    await expect(
      adminPage.getByRole("heading", { name: "Web Push identity", level: 2 }),
    ).toBeVisible();
    await docShot(adminPage, "admin-notifications");
  });
});
