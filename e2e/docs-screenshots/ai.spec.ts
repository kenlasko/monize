import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import {
  apiFor,
  dismissNotificationPrompt,
  open,
  waitForReady,
} from "../readme/session";
import { DESKTOP_CONTEXT, DESKTOP_VIEWPORT } from "../readme/settings";
import { loginUser } from "../helpers/auth";
import { E2E_DEFAULT_PASSWORD } from "../helpers/credentials";
import { cardOf, docShot, openAdminSession, theme } from "./capture";

// website/docs/ai.md. The instance has no AI provider and no API key, so no
// answer or insight can be produced. The pictures use a documentation user of
// their own (AI_USER) whose only provider is the MCP relay, which needs no key:
// that is enough to show the AI settings, the chat and its relay panel. The
// demo user is left without a provider, so nothing changes on its pages.

const AI_USER = {
  email: "avery.quinn@monize.example",
  firstName: "Avery",
  lastName: "Quinn",
  password: E2E_DEFAULT_PASSWORD,
};

interface AdminUserRow {
  id: string;
  email: string | null;
}

interface AiConfig {
  id: string;
  provider: string;
}

let context: BrowserContext;
let page: Page;

test.beforeAll(async ({ browser }) => {
  // The admin creates the user once; later runs find it.
  const admin = await openAdminSession(browser);
  const adminPage = await admin.newPage();
  await adminPage.goto("/dashboard");
  const adminApi = apiFor(adminPage);
  const users = await adminApi.get<AdminUserRow[]>("/admin/users");
  if (!users.some((u) => u.email === AI_USER.email)) {
    await adminApi.post("/admin/users", { ...AI_USER, role: "user" });
  }
  await admin.close();

  context = await browser.newContext({
    ...DESKTOP_CONTEXT,
    colorScheme: theme(),
  });
  page = await context.newPage();
  await loginUser(page, AI_USER.email, AI_USER.password);
  await dismissNotificationPrompt(page);
  const api = apiFor(page);
  await api.patch("/users/preferences", {
    theme: "system",
    aiBubbleEnabled: true,
  });
  const configs = await api.get<AiConfig[]>("/ai/configs");
  if (!configs.some((c) => c.provider === "mcp_relay")) {
    await api.post("/ai/configs", {
      provider: "mcp_relay",
      displayName: "MCP Relay",
    });
  }
});

test.afterAll(async () => {
  await context.close();
});

test("ai-settings", async () => {
  await open(page, "/settings/ai");
  await expect(
    page.getByRole("heading", { name: "AI Providers", level: 2 }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Usage", level: 2 }),
  ).toBeVisible();
  await docShot(page, "ai-settings");
});

test("ai-provider-form", async () => {
  // Tall enough that the whole form shows without scrolling inside the dialog.
  await page.setViewportSize({ width: 1600, height: 1800 });
  await open(page, "/settings/ai");
  await page.getByRole("button", { name: "Add Provider" }).click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "Add AI Provider" }),
  ).toBeVisible();
  await expect(dialog.getByLabel("API Key")).toBeVisible();
  await docShot(page, "ai-provider-form", dialog);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await page.setViewportSize(DESKTOP_VIEWPORT);
});

test("ai-relay-provider-form", async () => {
  // Tall enough that the whole form shows without scrolling inside the dialog.
  await page.setViewportSize({ width: 1600, height: 1800 });
  await open(page, "/settings/ai");
  await page.getByRole("button", { name: "Add Provider" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Provider").selectOption("mcp_relay");
  await expect(dialog.getByText("MCP Agent offline")).toBeVisible();
  await waitForReady(page);
  await docShot(page, "ai-relay-provider-form", dialog);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await page.setViewportSize(DESKTOP_VIEWPORT);
});

test("ai-usage", async () => {
  await open(page, "/settings/ai");
  const card = cardOf(page.getByRole("heading", { name: "Usage", level: 2 }));
  await card.scrollIntoViewIfNeeded();
  await docShot(page, "ai-usage", card);
});

test("ai-chat", async () => {
  await open(page, "/ai");
  await expect(
    page.getByRole("heading", { name: "AI Assistant", level: 1 }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Monthly spending/ }),
  ).toBeEnabled();
  await docShot(page, "ai-chat");
});

test("ai-relay-connect", async () => {
  await open(page, "/ai");
  await page.getByRole("button", { name: "How to connect" }).click();
  await expect(page.getByText("Connect with Claude CLI")).toBeVisible();
  await waitForReady(page);
  await docShot(page, "ai-relay-connect");
});

test("ai-chat-panel", async () => {
  await open(page, "/dashboard");
  await page.getByRole("button", { name: "Open AI assistant" }).click();
  const panel = page.getByRole("dialog", { name: "AI Assistant" });
  await expect(panel).toBeVisible();
  await waitForReady(page);
  await docShot(page, "ai-chat-panel");
  await panel.getByRole("button", { name: "Close" }).click();
});

test("ai-insights-page", async () => {
  await open(page, "/insights");
  await expect(
    page.getByRole("heading", { name: "Spending Insights", level: 1 }),
  ).toBeVisible();
  await docShot(page, "ai-insights-page");
});
