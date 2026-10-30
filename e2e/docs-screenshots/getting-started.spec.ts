import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import { open, scrollUnderHeader } from "../readme/session";
import { DESKTOP_CONTEXT } from "../readme/settings";
import { cardOf, docShot, openDocsSession, theme } from "./capture";

// website/docs/getting-started.md. The sign-up screens are shown without
// creating an account: the registration request is answered in the browser
// with the signed-in demo user, so the screens that follow it render, and
// nothing on them is submitted.

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  context = await openDocsSession(browser);
  page = await context.newPage();
});

test.afterAll(async () => {
  await context.close();
});

test("login-page", async ({ browser }) => {
  const signedOut = await browser.newContext({
    ...DESKTOP_CONTEXT,
    colorScheme: theme(),
  });
  const login = await signedOut.newPage();
  await login.goto("/login");
  await expect(
    login.getByRole("heading", { name: "Sign in to Monize" }),
  ).toBeVisible({
    timeout: 60_000,
  });
  await login.evaluate(() => document.fonts.ready);
  await docShot(login, "login-page");
  await signedOut.close();
});

test("registration-page", async ({ browser }) => {
  const signedOut = await browser.newContext({
    ...DESKTOP_CONTEXT,
    colorScheme: theme(),
  });
  const register = await signedOut.newPage();
  await register.goto("/register");
  await expect(
    register.getByRole("heading", { name: "Create your account" }),
  ).toBeVisible({
    timeout: 60_000,
  });
  await register.getByLabel("Email address").fill("alex.morgan@example.com");
  await register.getByLabel("First name").fill("Alex");
  await register.getByLabel("Last name").fill("Morgan");
  await register.evaluate(() => document.fonts.ready);
  await docShot(register, "registration-page");
  await signedOut.close();
});

test.describe("after creating an account", () => {
  test.describe.configure({ mode: "serial" });

  test("getting-started-secure-account", async () => {
    await page.goto("/dashboard");
    const me = await (await page.request.get("/api/v1/users/me")).json();
    await page.route("**/api/v1/auth/register", (route) =>
      route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ user: me }),
      }),
    );
    await page.goto("/register");
    await expect(
      page.getByRole("heading", { name: "Create your account" }),
    ).toBeVisible({
      timeout: 60_000,
    });
    const password = "Correct-Horse-42!";
    await page.getByLabel("Email address").fill("alex.morgan@example.com");
    await page.getByLabel("First name").fill("Alex");
    await page.getByLabel("Last name").fill("Morgan");
    await page.getByLabel("Password", { exact: true }).fill(password);
    await page.getByLabel("Confirm password").fill(password);
    await page.getByRole("button", { name: "Create account" }).click();
    await expect(
      page.getByRole("heading", { name: "Secure Your Account" }),
    ).toBeVisible();
    await expect(
      page.locator('div[role="status"][aria-live="polite"]'),
    ).toHaveCount(0);
    await docShot(page, "getting-started-secure-account");
  });

  test("getting-started-preferences", async () => {
    await page.getByRole("button", { name: "Skip for now" }).click();
    await expect(
      page.getByRole("heading", { name: "Set Your Preferences" }),
    ).toBeVisible();
    await expect(page.getByLabel("Default currency")).toHaveValue(/.+/);
    await docShot(page, "getting-started-preferences");
    await page.unroute("**/api/v1/auth/register");
  });
});

test("getting-started-dashboard-card", async () => {
  // The demo user dismissed the card long ago; this page is told it has not.
  await page.route("**/api/v1/users/preferences", async (route) => {
    if (route.request().method() !== "GET") return route.fallback();
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { ...body, gettingStartedDismissed: false },
    });
  });
  // The widgets below it keep loading for a while; only the card is pictured.
  await page.goto("/dashboard");
  const card = cardOf(page.getByRole("heading", { name: "Getting Started" }));
  await expect(card).toBeVisible({ timeout: 60_000 });
  await docShot(page, "getting-started-dashboard-card", card);
  await page.unroute("**/api/v1/users/preferences");
});

test("settings-page", async () => {
  await open(page, "/settings");
  const heading = page.getByRole("heading", { name: "Preferences", level: 2 });
  await expect(heading).toBeVisible({ timeout: 60_000 });
  await expect(page.getByLabel("Default Currency")).toBeVisible();
  await scrollUnderHeader(page, heading);
  await docShot(page, "settings-page");
});

test("getting-started-new-account", async () => {
  await open(page, "/accounts");
  await page
    .getByRole("button", { name: /New Account/ })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByLabel("Account Name")).toBeVisible();
  await dialog.getByLabel("Account Name").fill("Main Chequing");
  await docShot(page, "getting-started-new-account", dialog);
});

// On a page with no menu item of its own, so none is highlighted.
test("navigation-bar", async () => {
  await open(page, "/settings");
  await docShot(page, "navigation-bar", page.getByRole("banner"));
});

test("tools-dropdown", async () => {
  await open(page, "/settings");
  await page.getByRole("banner").getByRole("button", { name: "Tools" }).click();
  const menu = page
    .getByRole("button", { name: "Import Transactions" })
    .locator('xpath=ancestor::div[contains(@class, "absolute")][1]');
  await expect(menu).toBeVisible();
  await docShot(page, "tools-dropdown", menu);
});
