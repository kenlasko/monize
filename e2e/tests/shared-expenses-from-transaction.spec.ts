import { test, expect } from "../fixtures";
import {
  createAccount,
  createCategory,
  createPayee,
} from "../helpers/factories";
import {
  createSharedGroup,
  type SharedGroupFixture,
} from "../helpers/shared-expenses";
import { dismissNotificationPrompt } from "../readme/session";
import { VIDEO_VIEWPORT } from "../readme/settings";

test.use({ viewport: VIDEO_VIEWPORT });

test("keeps ordinary transaction creation separate and explains an old sharing URL", async ({
  authedPage: page,
  api,
}, info) => {
  const group = await createSharedGroup(api, "Dinner with friends");
  const bank = await createAccount(api, {
    name: "Everyday card",
    currencyCode: "USD",
    openingBalance: 1000,
  });
  const category = await createCategory(api, { name: "Meals with friends" });
  const payee = await createPayee(api, {
    name: "Harbour restaurant",
    defaultCategoryId: category.id,
  });
  await dismissNotificationPrompt(page);
  await page.goto("/transactions");
  await page
    .getByRole("button", { name: "+ New Transaction", exact: true })
    .click();
  const form = page.getByRole("dialog");
  await expect(
    form.getByRole("heading", { name: "New Transaction", exact: true }),
  ).toBeVisible();
  await form.getByLabel("Account", { exact: true }).selectOption(bank.id);
  await form
    .getByRole("textbox", { name: "Select or type payee name...", exact: true })
    .click();
  await page.getByText(payee.name, { exact: true }).click();
  await form.getByLabel("Amount", { exact: true }).fill("-120");
  await form
    .getByRole("button", { name: "Choose what happens after creating" })
    .click();
  await expect(
    page.getByRole("menuitemradio", { name: /Save & Share/ }),
  ).toHaveCount(0);
  await form
    .getByRole("button", { name: "Choose what happens after creating" })
    .click();
  await form
    .getByRole("button", { name: "Create Transaction", exact: true })
    .click();
  await expect(form).toHaveCount(0);
  await page.reload();
  const payments = await api.get<{ data: { id: string; amount: string }[] }>(
    `/transactions?accountId=${bank.id}`,
  );
  expect(payments.data).toHaveLength(1);
  expect(Number(payments.data[0].amount)).toBe(-120);
  const sourceId = payments.data[0].id;
  expect(
    (await api.get<SharedGroupFixture>(`/shared-expenses/groups/${group.id}`))
      .entries,
  ).toHaveLength(0);
  await page.goto(`/shared-expenses/from-transaction/${sourceId}`);
  await expect(
    page
      .getByRole("main")
      .getByText(/New personal-finance connections are unavailable/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create A Shared Expense" }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Groups", exact: true }).click();
  await expect(
    page.getByRole("table", { name: "Groups", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: info.outputPath("shared-groups-table.png"),
    fullPage: true,
    animations: "disabled",
  });
  expect(
    Number(
      (await api.get<{ currentBalance: string }>(`/accounts/${bank.id}`))
        .currentBalance,
    ),
  ).toBe(880);
});
