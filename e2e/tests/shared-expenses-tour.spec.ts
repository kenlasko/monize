import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";
import {
  createSharedGroup,
  type SharedGroupFixture,
} from "../helpers/shared-expenses";

async function startTour(page: Page) {
  await page.goto("/settings/tours");
  const row = page.getByRole("listitem").filter({
    has: page.getByText("Shared expenses", { exact: true }),
  });
  await row.getByRole("button", { name: "Start", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Share a trip, keep clear balances" }),
  ).toBeVisible();
}

async function nextTo(page: Page, title: string) {
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
}

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`explains shared expenses on ${viewport.name} without creating records`, async ({
    authedPage: page,
    api,
  }) => {
    await page.setViewportSize(viewport);
    const group = await createSharedGroup(api, "Mountain trip");
    await startTour(page);
    if (viewport.name === "desktop") {
      await nextTo(page, "Open Shared expenses");
      await expect(
        page.getByRole("button", { name: "Shared expenses", exact: true }),
      ).toBeVisible();
      // The dashboard keeps Customize, with feature navigation in Tools.
      await expect(
        page
          .getByRole("main")
          .getByRole("link", { name: "Shared Expenses", exact: true }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Customize", exact: true }),
      ).toBeVisible();
    }
    await nextTo(page, "Start with your group");
    await nextTo(page, "Explore a group");
    await page.getByRole("row", { name: /Mountain trip/ }).click();
    await expect(page).toHaveURL(new RegExp(`/shared-expenses/${group.id}$`));
    await expect(
      page.getByRole("heading", { name: "Who paid, and who benefited?" }),
    ).toBeVisible();
    await nextTo(page, "Check balances and settle up");
    await page.getByRole("tab", { name: "Balances", exact: true }).click();
    await expect(
      page.getByRole("tab", { name: "Balances", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
    await nextTo(page, "Ready for your next trip");
    await page.getByRole("button", { name: "Done", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "Ready for your next trip" }),
    ).toBeHidden();

    // Full navigation reloads persisted progress, rather than trusting the store.
    await page.goto("/settings/tours");
    const row = page.getByRole("listitem").filter({
      has: page.getByText("Shared expenses", { exact: true }),
    });
    await expect(row).toContainText("Viewed");
    await expect(
      row.getByRole("button", { name: "Retake", exact: true }),
    ).toBeVisible();
    expect(await api.get("/accounts")).toEqual([]);
    expect(await api.get("/shared-expenses/groups")).toHaveLength(1);
    const after = await api.get<SharedGroupFixture>(
      `/shared-expenses/groups/${group.id}`,
    );
    expect(after.entries).toEqual([]);
    expect(after.financialRevision).toBe(group.financialRevision);
  });
}

test("finishes on a phone when there is no group to open", async ({
  authedPage: page,
  api,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await startTour(page);
  await nextTo(page, "Start with your group");
  await nextTo(page, "Explore a group");
  await page
    .getByRole("button", { name: "Skip this step", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Ready for your next trip" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Tour finished", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Tour finished", exact: true }),
  ).toBeHidden();
  expect(await api.get("/shared-expenses/groups")).toEqual([]);
  expect(await api.get("/accounts")).toEqual([]);
});
