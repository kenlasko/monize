import { randomUUID } from "node:crypto";
import { rawApiRequest } from "../helpers/api";
import { test, expect } from "../fixtures";
import {
  createAccount,
  createCategory,
  createTransaction,
} from "../helpers/factories";
import {
  createSharedExpense,
  createSharedGroup,
  type SharedGroupFixture,
} from "../helpers/shared-expenses";
import { syntheticDocumentPng } from "../helpers/document-fixture";
import { dismissNotificationPrompt } from "../readme/session";
import { VIDEO_VIEWPORT } from "../readme/settings";

test.describe("Shared Expenses", () => {
  test.use({ viewport: VIDEO_VIEWPORT });

  test.beforeEach(async ({ authedPage }) => {
    await dismissNotificationPrompt(authedPage);
  });

  test("previews an ordinary mobile bill and records it with one save", async ({
    authedPage: page,
    api,
  }, info) => {
    const group = await createSharedGroup(api, "Dinner with friends");
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto(`/shared-expenses/${group.id}`);
    await page
      .getByRole("button", { name: "Add Expense", exact: true })
      .click();
    await page.getByRole("button", { name: "Expense", exact: true }).click();
    const editor = page.getByRole("dialog", {
      name: "Add Expense",
      exact: true,
    });
    await editor.getByLabel("Description").fill("Friday dinner");
    await editor.getByLabel("Amount", { exact: true }).fill("300");
    const save = editor.getByRole("button", {
      name: "Save",
      exact: true,
    });
    await expect(save).toBeEnabled();
    await expect(editor.getByText("Your Cost", { exact: false })).toContainText(
      "100.00",
    );
    await expect(
      editor.getByRole("switch", { name: /Also record this in my finances/ }),
    ).toHaveCount(0);
    expect(
      (await api.get<SharedGroupFixture>(`/shared-expenses/groups/${group.id}`))
        .entries,
    ).toHaveLength(0);
    await editor
      .getByText("Your Cost", { exact: false })
      .scrollIntoViewIfNeeded();
    await expect(
      editor.getByRole("heading", { name: "Add Expense", exact: true }),
    ).toBeInViewport();
    await expect(
      editor.getByText("Friday dinner", { exact: true }),
    ).toHaveCount(0);
    // Standard form actions scroll with the panel instead of a pinned footer.
    await save.scrollIntoViewIfNeeded();
    await expect(save).toBeInViewport();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: info.outputPath("expense-preview-mobile.png"),
      fullPage: false,
      animations: "disabled",
    });
    await page.setViewportSize(VIDEO_VIEWPORT);
    await editor
      .getByRole("heading", { name: "Add Expense", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: info.outputPath("expense-preview-desktop.png"),
      fullPage: false,
      animations: "disabled",
    });
    await save.click();
    await expect(editor).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole("main").getByText("Friday dinner", { exact: true }),
    ).toBeVisible();
    const saved = await api.get<SharedGroupFixture>(
      `/shared-expenses/groups/${group.id}`,
    );
    expect(saved.entries).toHaveLength(1);
    expect(saved.balances.totalExpenses).toBe("300.0000");
    expect(
      saved.balances.positions.find(
        (person) => person.participantId === group.myParticipantId,
      )?.balance,
    ).toBe("200.0000");
    await page.goto("/shared-expenses");
    await expect(
      page.getByRole("row").filter({ hasText: "Dinner with friends" }),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath("groups-overview-desktop.png"),
      fullPage: true,
      animations: "disabled",
    });
  });

  test("records an unequal split for people without accounts and keeps a partial repayment after reload", async ({
    authedPage: page,
    api,
  }, info) => {
    const group = await createSharedGroup(api);
    await page.goto(`/shared-expenses/${group.id}`);
    await page
      .getByRole("button", { name: "Add Expense", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: "Expense", exact: true }).click();
    const editor = page.getByRole("dialog", {
      name: "Add Expense",
      exact: true,
    });
    await editor.getByLabel("Description").fill("Dinner after the hike");
    await editor.getByLabel("Amount", { exact: true }).fill("300");
    await editor
      .getByRole("button", { name: "Change Split", exact: true })
      .click();
    const split = page.getByRole("dialog", {
      name: "Split Between",
      exact: true,
    });
    await split.getByLabel("Share for Robert").fill("80");
    await split.getByLabel("Share for Anna").fill("110");
    await split.getByLabel("Share for Bartek").fill("110");
    await expect(
      split.getByRole("button", { name: "Apply Split" }),
    ).toBeEnabled();
    await page.setViewportSize({ ...VIDEO_VIEWPORT, height: 1080 });
    await page.screenshot({
      path: info.outputPath("unequal-split-desktop.png"),
      fullPage: false,
      animations: "disabled",
    });
    await page.setViewportSize(VIDEO_VIEWPORT);
    await split.getByRole("button", { name: "Apply Split" }).click();
    await expect(
      editor.getByRole("button", { name: "Save", exact: true }),
    ).toBeEnabled();
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await page.reload();
    await expect(
      page
        .getByRole("main")
        .getByText("Dinner after the hike", { exact: true }),
    ).toBeVisible();
    const detail = await api.get<SharedGroupFixture>(
      `/shared-expenses/groups/${group.id}`,
    );
    expect(
      detail.balances.positions.find(
        (person) => person.participantId === group.myParticipantId,
      )?.balance,
    ).toBe("220.0000");
    await page.screenshot({
      path: info.outputPath("group-desktop.png"),
      fullPage: true,
      animations: "disabled",
    });
    await page.getByRole("tab", { name: "Balances", exact: true }).click();
    await page
      .getByRole("button", { name: "Record Repayment", exact: true })
      .first()
      .click();
    const repayment = page.getByRole("dialog", {
      name: "Record Repayment",
      exact: true,
    });
    await repayment.getByLabel("Amount", { exact: true }).fill("50");
    await repayment.getByRole("button", { name: "Save", exact: true }).click();
    await expect(repayment).toHaveCount(0);
    await page.reload();
    const after = await api.get<SharedGroupFixture>(
      `/shared-expenses/groups/${group.id}`,
    );
    expect(
      after.balances.positions.find(
        (person) => person.participantId === group.myParticipantId,
      )?.balance,
    ).toBe("170.0000");
    expect(after.balances.totalExpenses).toBe("300.0000");
    await page.setViewportSize({ width: 360, height: 800 });
    await page.getByRole("tab", { name: "Balances", exact: true }).click();
    await expect(
      page.getByRole("main").getByText("Anna", { exact: true }).first(),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: info.outputPath("balances-mobile.png"),
      fullPage: true,
      animations: "disabled",
    });
  });

  test("keeps a standalone group file when entry creation is cancelled, then attaches it without duplicating it", async ({
    authedPage: page,
    api,
  }, info) => {
    const group = await createSharedGroup(api, "Summer apartment");
    await page.goto(`/shared-expenses/${group.id}`);
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await page.getByLabel("Add attachment").setInputFiles({
      name: "Apartment booking.png",
      mimeType: "image/png",
      buffer: syntheticDocumentPng(),
    });
    await page
      .getByRole("button", { name: "Upload Files", exact: true })
      .click();
    await expect(
      page.getByRole("button", {
        name: "Create Expense From This File",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", {
        name: "Create Expense From This File",
        exact: true,
      })
      .click();
    const editor = page.getByRole("dialog", {
      name: "Add Expense",
      exact: true,
    });
    await expect(editor.getByLabel("Description")).toHaveValue(
      "Apartment booking",
    );
    await editor.getByRole("button", { name: "Cancel", exact: true }).click();
    // Modal cleanup pops its history entry asynchronously; let that traversal
    // finish before opening another modal or starting a reload.
    await page.waitForFunction(() => !window.history.state?.modal);
    await expect(
      page.getByRole("button", {
        name: "Create Expense From This File",
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", {
        name: "Create Expense From This File",
        exact: true,
      })
      .click();
    await editor.getByLabel("Amount", { exact: true }).fill("240");
    await expect(
      editor.getByRole("button", { name: "Save", exact: true }),
    ).toBeEnabled();
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await expect(editor).toHaveCount(0);
    await page.waitForFunction(() => !window.history.state?.modal);
    await page.reload();
    await page.getByRole("tab", { name: "Files", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Open Related Entry", exact: true }),
    ).toBeVisible();
    const documents = await api.get<{
      items: { filename: string; sharedEntryId: string | null }[];
    }>(`/shared-expenses/groups/${group.id}/documents`);
    expect(documents.items).toHaveLength(1);
    expect(documents.items[0].sharedEntryId).toBeTruthy();
    await expect(
      page.getByRole("main").getByText("No attachments yet", { exact: true }),
    ).toHaveCount(0);
    await page.screenshot({
      path: info.outputPath("files-desktop.png"),
      fullPage: true,
      animations: "disabled",
    });
    await page
      .getByRole("button", { name: "Open Related Entry", exact: true })
      .click();
    const detail = page.getByRole("dialog", {
      name: "Apartment booking",
      exact: true,
    });
    await expect(
      detail.getByRole("heading", { name: "Apartment booking", exact: true }),
    ).toBeVisible();
    await expect(
      detail.getByText("Apartment booking.png", { exact: true }),
    ).toBeVisible();
  });

  test("refuses new private booking without changing an existing imported debit", async ({
    authedPage: page,
    api,
  }) => {
    const group = await createSharedGroup(api);
    const entry = await createSharedExpense(api, group);
    const bank = await createAccount(api, {
      name: "Travel card",
      currencyCode: "USD",
      openingBalance: 1000,
    });
    const category = await createCategory(api, { name: "Travel meals" });
    const imported = await createTransaction(api, {
      accountId: bank.id,
      amount: -300,
      categoryId: category.id,
      payeeName: "Mountain market",
    });
    const accounts = await api.get("/accounts");
    const original = await api.get(`/transactions/${imported.id}`);
    await page.goto(`/shared-expenses/${group.id}`);
    await expect(
      page.getByRole("button", { name: "My Finances", exact: true }),
    ).toHaveCount(0);
    for (const suffix of [
      "enable",
      `entries/${entry.id}/preview`,
      `entries/${entry.id}/book`,
    ]) {
      const response = await rawApiRequest(
        page.request,
        "POST",
        `/shared-expenses/groups/${group.id}/finances/${suffix}`,
        { operationId: randomUUID(), expectedRevision: 0 },
      );
      expect(response.status()).toBe(409);
    }
    await page.reload();
    expect(await api.get("/accounts")).toEqual(accounts);
    expect(await api.get(`/transactions/${imported.id}`)).toEqual(original);
    expect(
      Number(
        (await api.get<{ currentBalance: string }>(`/accounts/${bank.id}`))
          .currentBalance,
      ),
    ).toBe(700);
  });

  test("keeps a saved expense and retries only its failed staged receipt", async ({
    authedPage: page,
    api,
  }, info) => {
    const group = await createSharedGroup(api, "Coffee on the trail");
    await page.goto(`/shared-expenses/${group.id}`);
    await page
      .getByRole("button", { name: "Add Expense", exact: true })
      .click();
    await page.getByRole("button", { name: "Expense", exact: true }).click();
    const editor = page.getByRole("dialog", {
      name: "Add Expense",
      exact: true,
    });
    await editor.getByLabel("Description").fill("Coffee at the mountain hut");
    await editor.getByLabel("Amount", { exact: true }).fill("60");
    await editor.getByLabel("Add attachment").setInputFiles({
      name: "Coffee receipt.png",
      mimeType: "image/png",
      buffer: syntheticDocumentPng(),
    });
    let attempts = 0;
    await page.route(
      "**/shared-expenses/groups/*/entries/*/attachments",
      async (route) => {
        if (route.request().method() === "POST" && attempts++ === 0) {
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ message: "Upload interrupted" }),
          });
        } else await route.continue();
      },
    );
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    const pending = page.getByRole("dialog", { name: "Saved", exact: true });
    await expect(pending.getByRole("alert")).toContainText(
      "Upload interrupted",
    );
    await expect(pending.getByLabel("Description")).toHaveValue(
      "Coffee at the mountain hut",
    );
    const saved = await api.get<SharedGroupFixture>(
      `/shared-expenses/groups/${group.id}`,
    );
    expect(saved.entries).toHaveLength(1);
    await pending
      .getByRole("button", { name: "Try Again", exact: true })
      .click();
    await expect(pending).toHaveCount(0);
    await page.reload();
    expect(
      (await api.get<SharedGroupFixture>(`/shared-expenses/groups/${group.id}`))
        .entries,
    ).toHaveLength(1);
    const files = await api.get<{ filename: string }[]>(
      `/shared-expenses/groups/${group.id}/entries/${saved.entries[0].id}/attachments`,
    );
    expect(files.map((file) => file.filename)).toEqual(["Coffee receipt.png"]);
    await expect(
      page.getByRole("row").filter({ hasText: "Coffee at the mountain hut" }),
    ).toBeVisible();
    await page.screenshot({
      path: info.outputPath("expense-with-receipt.png"),
      fullPage: true,
      animations: "disabled",
    });
  });
});
