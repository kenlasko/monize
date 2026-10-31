import { randomUUID } from "node:crypto";
import { test, expect } from "../fixtures";
import { rawApiRequest } from "../helpers/api";
import { dismissNotificationPrompt } from "../readme/session";
import { VIDEO_VIEWPORT } from "../readme/settings";
import { createAccount, createCategory } from "../helpers/factories";
import {
  createSharedGroup,
  createSharedSplitSource,
} from "../helpers/shared-expenses";
import type { SharedGroupDetail } from "../../frontend/src/types/shared-expense";

test.describe("Group-only financial boundary", () => {
  test.use({ viewport: VIDEO_VIEWPORT });
  test.beforeEach(async ({ authedPage }) => {
    await dismissNotificationPrompt(authedPage);
  });

  test("refuses a combined command and preserves every category portion of a bank receipt", async ({
    authedPage: page,
    api,
  }) => {
    const group = await createSharedGroup(api, "Split purchases");
    const bank = await createAccount(api, {
      name: "Shopping card",
      currencyCode: "USD",
      openingBalance: 1000,
    });
    const meal = await createCategory(api, { name: "Shared food" });
    const supplies = await createCategory(api, { name: "Private supplies" });
    const source = await createSharedSplitSource(
      api,
      bank.id,
      meal.id,
      supplies.id,
    );
    const original = await api.get(`/transactions/${source.id}`);
    const accounts = await api.get("/accounts");
    for (const suffix of ["/preview", ""]) {
      const response = await rawApiRequest(
        page.request,
        "POST",
        `/shared-expenses/groups/${group.id}/entry-finances${suffix}`,
        {
          operationId: randomUUID(),
          expectedRevision: group.revision,
          finance: { bankTransactionId: source.id },
        },
      );
      expect(response.status()).toBe(409);
    }
    await page.goto(`/shared-expenses/${group.id}?view=myFinances`);
    await expect(
      page
        .getByRole("main")
        .getByText(/New personal-finance connections are unavailable/),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Set Up My Finances", exact: true }),
    ).toHaveCount(0);
    await page.reload();
    expect(await api.get(`/transactions/${source.id}`)).toEqual(original);
    expect(await api.get("/accounts")).toEqual(accounts);
    expect(
      (await api.get<SharedGroupDetail>(`/shared-expenses/groups/${group.id}`))
        .entries,
    ).toHaveLength(0);
  });

  test.describe("Phone trip", () => {
    test.use({
      isMobile: async ({ browserName }, use) => {
        await use(browserName === "chromium");
      },
      hasTouch: true,
    });
    test("keeps six friends and a fixed coffee share while changing beneficiaries and filtering the table", async ({
      authedPage: page,
      api,
    }, info) => {
      const created = await api.post<{ id: string }>(
        "/shared-expenses/groups",
        {
          operationId: randomUUID(),
          name: "A week in the mountains",
          myName: "Robert",
          currencyCode: "USD",
          participants: ["Anna", "Bartek", "Dana", "Eli", "Fran"].map(
            (name) => ({
              name,
            }),
          ),
        },
      );
      const beforeAccounts = await api.get("/accounts");
      const group = await api.get<SharedGroupDetail>(
        `/shared-expenses/groups/${created.id}`,
      );
      await page.goto(`/shared-expenses/${group.id}`);
      await page
        .getByRole("button", { name: "Add Expense", exact: true })
        .click();
      await page.getByRole("button", { name: "Expense", exact: true }).click();
      const editor = page.getByRole("dialog", {
        name: "Add Expense",
        exact: true,
      });
      await editor
        .getByLabel("Description")
        .fill("Coffee and lunch at the hut");
      await editor.getByLabel("Amount", { exact: true }).fill("100");
      await editor
        .getByLabel("Paid By", { exact: true })
        .selectOption(group.participants.find((p) => p.name === "Fran")!.id);
      await editor
        .getByRole("button", { name: "Change Split", exact: true })
        .click();
      const split = page.getByRole("dialog", {
        name: "Split Between",
        exact: true,
      });
      for (const [name, amount] of [
        ["Bartek", "20"],
        ["Dana", "0"],
        ["Eli", "0"],
        ["Fran", "0"],
      ]) {
        await split.getByLabel(`Share for ${name}`).fill(amount);
      }
      await expect(split.getByLabel("Share for Robert")).toHaveValue("40.00");
      await expect(split.getByLabel("Share for Anna")).toHaveValue("40.00");
      await split
        .getByRole("button", { name: "Apply Split", exact: true })
        .click();
      await editor.getByRole("button", { name: "Save", exact: true }).click();
      await expect(editor).toHaveCount(0);
      await page.reload();
      const saved = await api.get<SharedGroupDetail>(
        `/shared-expenses/groups/${group.id}`,
      );
      expect(saved.participants).toHaveLength(6);
      expect(saved.entries).toHaveLength(1);
      const shares = saved.entries[0].allocations.filter(
        (a) => a.kind === "SHARE",
      );
      for (const [name, amount] of [
        ["Robert", "40.0000"],
        ["Anna", "40.0000"],
        ["Bartek", "20.0000"],
        ["Fran", "0.0000"],
      ]) {
        const participant = saved.participants.find((p) => p.name === name)!;
        expect(
          shares.find((s) => s.participantId === participant.id)
            ?.originalAmount,
        ).toBe(amount);
      }
      const payer = saved.balances.positions.find(
        (p) =>
          p.participantId ===
          saved.participants.find((p) => p.name === "Fran")!.id,
      );
      expect(payer?.balance).toBe("100.0000");
      expect(await api.get("/accounts")).toEqual(beforeAccounts);
      await page.getByLabel("Search descriptions and notes").fill("Coffee");
      await page.getByLabel("Search descriptions and notes").press("Tab");
      await expect(
        page.getByRole("row").filter({ hasText: "Coffee and lunch" }),
      ).toBeVisible();
      await page.getByRole("button", { name: "Clear", exact: true }).click();
      await expect(
        page.getByLabel("Search descriptions and notes"),
      ).toHaveValue("");
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        const row = page
          .getByRole("row")
          .filter({ hasText: "Coffee and lunch" });
        await expect(row).toHaveAttribute("aria-disabled", "false");
        expect(
          await row.evaluate((element) =>
            Array.from(element.querySelectorAll("td")).every(
              (cell) => cell.scrollWidth <= cell.clientWidth,
            ),
          ),
        ).toBe(true);
        expect(
          await page
            .getByRole("table", { name: "Expenses", exact: true })
            .evaluate(
              (table) =>
                table.parentElement!.scrollWidth <=
                table.parentElement!.clientWidth,
            ),
        ).toBe(true);
        await page.screenshot({
          path: info.outputPath(`trip-table-${width}.png`),
          fullPage: true,
          animations: "disabled",
        });
      }
    });
  });
});
