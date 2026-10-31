import { test, expect } from "../fixtures";
import {
  createAccount,
  createCategory,
  createCurrency,
  createTag,
} from "../helpers/factories";
import { createSharedGroup } from "../helpers/shared-expenses";
import { dismissNotificationPrompt } from "../readme/session";
import { VIDEO_VIEWPORT } from "../readme/settings";
import type { SharedGroupDetail } from "../../frontend/src/types/shared-expense";

test.use({ viewport: VIDEO_VIEWPORT });

test("records USD and CAD group bills while leaving a tagged bank payment untouched", async ({
  authedPage: page,
  api,
}, info) => {
  test.setTimeout(120_000);
  await dismissNotificationPrompt(page);
  // A fresh instance creates currencies on demand. Give this user CAD before
  // creating the trip, just as choosing it in currency settings would do.
  await createCurrency(api, {
    code: "CAD",
    name: "Canadian Dollar",
    symbol: "$",
  });
  const group = await createSharedGroup(api, "Canada to US road trip", "CAD");
  const anna = group.participants.find((person) => person.name === "Anna")!;
  const bank = await createAccount(api, {
    name: "USD travel account",
    currencyCode: "USD",
    openingBalance: 2000,
  });
  const category = await createCategory(api, { name: "Road trip" });
  const tag = await createTag(api, { name: "US road trip" });
  const date = new Date().toISOString().slice(0, 10);
  const source = await api.post<{ id: string }>("/transactions", {
    accountId: bank.id,
    amount: -900,
    currencyCode: "USD",
    transactionDate: date,
    payeeName: "Lakeview cabin",
    categoryId: category.id,
    tagIds: [tag.id],
  });

  await page.goto(`/shared-expenses/${group.id}`);
  await page.getByRole("button", { name: "Add Expense", exact: true }).click();
  await page.getByRole("button", { name: "Expense", exact: true }).click();
  const editor = page.getByRole("dialog", { name: "Add Expense", exact: true });
  await editor.getByLabel("Description").fill("Lakeview cabin");
  await editor
    .getByRole("button", { name: "Change entry currency", exact: true })
    .first()
    .click();
  await page.getByRole("button", { name: /Dollar.*USD/ }).click();
  await editor.getByLabel("Amount", { exact: true }).fill("900");
  const more = editor
    .locator("details")
    .filter({ has: page.getByText("More Options", { exact: true }) });
  if ((await more.getAttribute("open")) === null) {
    await more.locator("summary").first().click();
  }
  await editor.getByLabel("Agreed Exchange Rate", { exact: true }).fill("1.35");
  await editor.getByLabel("Description").click();
  const conversion = editor.getByRole("region", {
    name: "Currency conversion",
  });
  await expect(conversion).toContainText("1 USD = 1.350000 CAD");
  await expect(conversion).toContainText("1,215.00");
  await expect(conversion).toContainText("Entered rate");
  await conversion.scrollIntoViewIfNeeded();
  await expect(conversion).toBeInViewport();
  await page.screenshot({
    path: info.outputPath("usd-cad-preview.png"),
    animations: "disabled",
  });

  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Canada to US road trip", exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByText("Balances and totals in CAD")).toBeVisible();
  await expect(
    page.getByRole("main").getByText("$900.00 USD", { exact: true }),
  ).toBeVisible();
  const saved = await api.get<SharedGroupDetail>(
    `/shared-expenses/groups/${group.id}`,
  );
  expect(saved.entries).toHaveLength(1);
  expect(saved.entries[0]).toMatchObject({
    originalAmount: "900.0000",
    currencyCode: "USD",
    groupAmount: "1215.0000",
    fxRate: "1.3500000000",
    fxSource: "MANUAL",
  });
  const bankAfter = await api.get<{ currentBalance: string }>(
    `/accounts/${bank.id}`,
  );
  expect(Number(bankAfter.currentBalance)).toBe(1100);
  const matched = await api.get<{
    id: string;
    amount: string;
    sharedExpensePostingId: string;
    tags: { id: string }[];
  }>(`/transactions/${source.id}`);
  expect(matched.id).toBe(source.id);
  expect(Number(matched.amount)).toBe(-900);
  expect(matched.sharedExpensePostingId).toBeNull();
  expect(matched.tags.map((item) => item.id)).toContain(tag.id);

  await page.getByRole("button", { name: "Add Expense", exact: true }).click();
  await page.getByRole("button", { name: "Expense", exact: true }).click();
  await editor.getByLabel("Description").fill("Fuel before the border");
  await expect(
    editor
      .getByRole("button", { name: "Change entry currency", exact: true })
      .first(),
  ).toBeEnabled();
  await editor.getByLabel("Amount", { exact: true }).fill("100+35");
  await editor.getByLabel("Amount", { exact: true }).press("Enter");
  await editor.getByLabel("Paid By", { exact: true }).selectOption(anna.id);
  await expect(editor.getByLabel("Amount", { exact: true })).toHaveValue(
    "135.00",
  );
  await expect(editor.getByText("Your Cost", { exact: false })).toContainText(
    "45.00",
  );
  await editor.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("tab", { name: "Balances", exact: true }).click();
  const suggestion = page
    .getByRole("listitem")
    .filter({ hasText: "Anna → Robert" });
  await expect(suggestion).toContainText("315.00");
  await suggestion
    .getByRole("button", { name: "Record Repayment", exact: true })
    .click();
  const repayment = page.getByRole("dialog", {
    name: "Record Repayment",
    exact: true,
  });
  await repayment.getByLabel("Amount", { exact: true }).fill("100");
  await repayment.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.reload();
  await page.getByRole("tab", { name: "Balances", exact: true }).click();
  await expect(
    page.getByRole("listitem").filter({ hasText: "Anna → Robert" }),
  ).toContainText("215.00");
  const after = await api.get<SharedGroupDetail>(
    `/shared-expenses/groups/${group.id}`,
  );
  expect(after.balances.totalExpenses).toBe("1350.0000");
  expect(
    after.balances.positions.find(
      (person) => person.participantId === group.myParticipantId,
    ),
  ).toMatchObject({ cost: "450.0000", balance: "665.0000" });
  expect(
    after.entries.find((entry) => entry.id === saved.entries[0].id),
  ).toMatchObject({ fxRate: "1.3500000000", groupAmount: "1215.0000" });
  expect(
    Number(
      (await api.get<{ currentBalance: string }>(`/accounts/${bank.id}`))
        .currentBalance,
    ),
  ).toBe(1100);
  await page.setViewportSize({ width: 360, height: 800 });
  await expect(page.getByText("Balances and totals in CAD")).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: info.outputPath("usd-cad-balances-mobile.png"),
    fullPage: true,
    animations: "disabled",
  });
});
