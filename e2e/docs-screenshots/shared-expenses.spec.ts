import { test, expect } from "../fixtures";
import {
  createSharedExpense,
  createSharedGroup,
} from "../helpers/shared-expenses";
import { docShot } from "./capture";
import { dismissNotificationPrompt } from "../readme/session";

// Separate fresh users keep documentation captures reproducible without
// changing a real trip or sharing mutable groups with the functional tests.
test("dashboard-header", async ({ authedPage: page, api }) => {
  await api.patch("/users/preferences", { theme: "dark" });
  await page.goto("/dashboard");
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

test("shared-expenses-balances", async ({ authedPage: page, api }) => {
  await api.patch("/users/preferences", { theme: "dark" });
  const group = await createSharedGroup(api, "Mountain trip");
  await createSharedExpense(api, group, "Groceries for the cabin");
  await page.goto(`/shared-expenses/${group.id}`);
  await page.getByRole("tab", { name: "Balances", exact: true }).click();
  await expect(
    page.getByRole("tab", { name: "Balances", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await docShot(page, "shared-expenses-balances", page.getByRole("main"));
});

test("shared-expenses-tour", async ({ authedPage: page, api }) => {
  await api.patch("/users/preferences", { theme: "dark" });
  await dismissNotificationPrompt(page);
  await createSharedGroup(api, "Mountain trip");
  await page.goto("/settings/tours");
  await page
    .getByRole("listitem")
    .filter({
      has: page.getByText("Shared expenses", { exact: true }),
    })
    .getByRole("button", { name: "Start", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Share a trip, keep clear balances" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Open Shared expenses", exact: true }),
  ).toBeVisible();
  await docShot(page, "shared-expenses-tour");
  await page.getByRole("button", { name: "End tour", exact: true }).click();
});
