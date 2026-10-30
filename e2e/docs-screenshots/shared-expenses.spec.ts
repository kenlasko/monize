import { test, expect } from "@playwright/test";
import {
  createSharedExpense,
  createSharedGroup,
} from "../helpers/shared-expenses";
import { docShot, openDocsSession } from "./capture";
import { apiFor } from "../readme/session";

// The demo data has no shared groups. Each picture gets its own group through
// the API, while openDocsSession selects the dark or light project's theme.
test("shared-expenses-balances", async ({ browser }) => {
  const context = await openDocsSession(browser);
  try {
    const page = await context.newPage();
    await page.goto("/shared-expenses");
    const api = apiFor(page);
    const group = await createSharedGroup(api, "Mountain trip");
    await createSharedExpense(api, group, "Groceries for the cabin");
    await page.goto(`/shared-expenses/${group.id}`);
    await page.getByRole("tab", { name: "Balances", exact: true }).click();
    await expect(
      page.getByRole("tab", { name: "Balances", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await docShot(page, "shared-expenses-balances", page.getByRole("main"));
  } finally {
    await context.close();
  }
});

test("shared-expenses-expense", async ({ browser }) => {
  const context = await openDocsSession(browser);
  try {
    const page = await context.newPage();
    await page.goto("/shared-expenses");
    const group = await createSharedGroup(apiFor(page), "Mountain trip");
    await page.goto(`/shared-expenses/${group.id}`);
    await page
      .getByRole("button", { name: "Add Expense", exact: true })
      .click();
    await page.getByRole("button", { name: "Expense", exact: true }).click();
    const editor = page.getByRole("dialog", {
      name: "Add Expense",
      exact: true,
    });
    await editor.getByLabel("Description").fill("Groceries for the cabin");
    await editor.getByLabel("Amount", { exact: true }).fill("90");
    await editor.getByLabel("Description").click();
    await expect(
      editor.getByRole("button", { name: "Change Split", exact: true }),
    ).toBeVisible();
    await docShot(page, "shared-expenses-expense", editor);
  } finally {
    await context.close();
  }
});

test("shared-expenses-tour", async ({ browser }) => {
  const context = await openDocsSession(browser);
  try {
    const page = await context.newPage();
    await page.goto("/settings/tours");
    await page
      .getByRole("listitem")
      .filter({
        has: page.getByText("Shared expenses", { exact: true }),
      })
      .getByRole("button", { name: /^(Start|Retake)$/ })
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
  } finally {
    await context.close();
  }
});
