import { test, expect } from "../fixtures";
import type { Locator } from "@playwright/test";
import { dismissNotificationPrompt } from "../readme/session";
import {
  createSharedExpense,
  createSharedGroup,
} from "../helpers/shared-expenses";

/** Measure the rendered space, not a Tailwind class or a DOM snapshot. */
async function expectGap(above: Locator, below: Locator) {
  await expect(above).toBeVisible();
  await expect(below).toBeVisible();
  await expect
    .poll(async () => {
      const a = await above.boundingBox();
      const b = await below.boundingBox();
      return a && b ? b.y - a.y - a.height : -1;
    })
    .toBeGreaterThanOrEqual(15);
}

test.describe("Shared expenses final review", () => {
  test.beforeEach(async ({ authedPage }) =>
    dismissNotificationPrompt(authedPage),
  );

  test("separates tabs and attachments on desktop and phone and keeps explicit close actions", async ({
    authedPage: page,
    api,
  }, info) => {
    const group = await createSharedGroup(api, "Mountain trip layout");
    await createSharedExpense(api, group, "Groceries for the hut");
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto("/shared-expenses");
      await expectGap(
        page.getByRole("tablist"),
        page.getByLabel("Search groups"),
      );
      await page
        .getByRole("row")
        .filter({ hasText: "Mountain trip layout" })
        .click();
      await expectGap(
        page.getByRole("tablist"),
        page.getByLabel("Search descriptions and notes"),
      );
      await expect(page.getByText("Showing", { exact: false })).toHaveText(
        /1\s*-\s*1.*1.*Expenses/,
      );
      await page.screenshot({
        path: info.outputPath(`group-${width}.png`),
        fullPage: true,
        animations: "disabled",
      });
      await page
        .getByRole("row")
        .filter({ hasText: "Groceries for the hut" })
        .click();
      const detail = page.getByRole("dialog", {
        name: "Groceries for the hut",
        exact: true,
      });
      await expectGap(
        detail
          .getByRole("heading", { name: "Review", exact: true })
          .locator("../.."),
        detail.getByTestId("attachments-header"),
      );
      await page.screenshot({
        path: info.outputPath(`expense-${width}.png`),
        fullPage: true,
        animations: "disabled",
      });
      await detail.getByRole("button", { name: "Edit", exact: true }).click();
      const editor = page.getByRole("dialog", {
        name: "Edit",
        exact: true,
      });
      await expectGap(
        editor
          .getByRole("heading", { name: "Review", exact: true })
          .locator("../.."),
        editor.getByTestId("attachments-header"),
      );
      await editor.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(editor).toHaveCount(0);
      await page
        .getByRole("row")
        .filter({ hasText: "Groceries for the hut" })
        .click();
      await detail.getByRole("button", { name: "Close", exact: true }).click();
      await expect(detail).toHaveCount(0);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
    }
    await page.goto("/dashboard");
    await expect(page.getByRole("main")).toBeVisible();
    await expect(
      page.getByText("No changes to accepted entries need review.", {
        exact: true,
      }),
    ).toHaveCount(0);
  });

  test("pages groups from both ends and retains the single-page filter count after reload", async ({
    authedPage: page,
    api,
  }, info) => {
    for (let i = 0; i < 26; i += 1)
      await createSharedGroup(api, `Trip ${String(i).padStart(2, "0")}`);
    await page.goto("/shared-expenses");
    await expect(page.getByTitle("Next page", { exact: true })).toHaveCount(2);
    await page.getByTitle("Next page", { exact: true }).first().click();
    await expect(
      page.getByText("Showing", { exact: false }).first(),
    ).toHaveText(/26\s*-\s*26.*26.*Groups/);
    await page.getByTitle("Previous page", { exact: true }).last().click();
    await expect(
      page.getByText("Showing", { exact: false }).first(),
    ).toHaveText(/1\s*-\s*25.*26.*Groups/);
    await page.getByLabel("Search groups").fill("Trip 17");
    await expect(page.getByText("Showing", { exact: false })).toHaveText(
      /1\s*-\s*1.*1.*Groups/,
    );
    await expect(page.getByTitle("Next page", { exact: true })).toBeDisabled();
    await page.screenshot({
      path: info.outputPath("groups-filtered.png"),
      fullPage: true,
      animations: "disabled",
    });
    await page.reload();
    await expect(page.getByTitle("Next page", { exact: true })).toHaveCount(2);
    await page.getByTitle("Next page", { exact: true }).last().click();
    await expect(
      page.getByText("Showing", { exact: false }).first(),
    ).toHaveText(/26\s*-\s*26.*26.*Groups/);
  });
});
