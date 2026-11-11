import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";

// The 1.21 release tours each hand control to the reader: a keyboard
// shortcut, the page's ? icon and the dashboard gear open what the tour then
// walks through, and the reader closes it again with its own button. These
// runs press those real controls, so a card parked over one, or an anchor that
// never mounts, fails here rather than in front of a user.

async function startTour(
  page: Page,
  title: string,
  welcome: string,
  { waitForGuide = false } = {},
) {
  // The ? beside a page title opens the panel only once the guide index has
  // answered; before that, a click falls through to monize.net. The tour page
  // has a ? of its own, so its prefetch fills the cache the later page reads.
  const guide = waitForGuide
    ? page.waitForResponse(
        (r) => new URL(r.url()).pathname.endsWith("/help") && r.ok(),
      )
    : null;
  await page.goto("/settings/tours");
  if (guide) await (await guide).finished();
  const row = page.getByRole("listitem").filter({
    has: page.getByText(title, { exact: true }),
  });
  await row.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("heading", { name: welcome })).toBeVisible();
}

async function expectStep(page: Page, title: string) {
  await expect(
    page.getByRole("heading", { name: title, exact: true }),
  ).toBeVisible();
}

async function nextTo(page: Page, title: string) {
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expectStep(page, title);
}

async function finish(page: Page, title: string) {
  await page.getByRole("button", { name: "Done", exact: true }).click();
  await expect(page.getByRole("heading", { name: title })).toBeHidden();
}

async function expectViewed(page: Page, title: string) {
  // A full navigation reloads persisted progress rather than trusting the store.
  await page.goto("/settings/tours");
  const row = page.getByRole("listitem").filter({
    has: page.getByText(title, { exact: true }),
  });
  await expect(
    row.getByRole("button", { name: "Retake", exact: true }),
  ).toBeVisible();
}

test.describe("1.21 release tours", () => {
  test.beforeEach(async ({ authedPage: page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  test("walks the command palette opened with the shortcut", async ({
    authedPage: page,
  }) => {
    await startTour(page, "Command palette", "Find anything from one box");
    await nextTo(page, "Open the palette");

    await page.keyboard.press("ControlOrMeta+k");
    await expectStep(page, "Type what you are looking for");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    const box = palette.getByRole("combobox", { name: "Command palette" });
    // The box stays usable while the step explains it.
    await box.fill("Currencies");
    await expect(box).toHaveValue("Currencies");

    await nextTo(page, "Move and open");
    await nextTo(page, "Close the palette");
    await palette.getByRole("button", { name: "Close", exact: true }).click();
    await expect(box).toBeHidden();
    await expectStep(page, "One shortcut to remember");
    await finish(page, "One shortcut to remember");
    await expectViewed(page, "Command palette");
  });

  test("opens the help panel from the page title and closes it with its button", async ({
    authedPage: page,
  }) => {
    await startTour(page, "Help inside the app", "The user guide, beside your work", {
      waitForGuide: true,
    });
    await nextTo(page, "Open help for this page");
    await expect(page).toHaveURL(/\/transactions/);

    await page
      .getByRole("main")
      .getByRole("link", { name: "Help for this page", exact: true })
      .click();
    await expectStep(page, "Read alongside the page");
    const panel = page.getByRole("complementary", { name: "Help" });
    await expect(panel).toBeVisible();

    await nextTo(page, "Panel controls");
    await panel.getByRole("button", { name: "Close help", exact: true }).click();
    await expect(panel).toBeHidden();
    await expectStep(page, "The Help menu");

    await nextTo(page, "Learn more, where you need it");
    await nextTo(page, "Ask in your own words");
    await finish(page, "Ask in your own words");
    await expectViewed(page, "Help inside the app");
  });

  test("enters dashboard edit mode from the gear and leaves with Cancel", async ({
    authedPage: page,
  }) => {
    await startTour(page, "Arranging the dashboard", "Arrange your dashboard in place");
    await nextTo(page, "Enter edit mode");

    await page.getByRole("button", { name: "Customize", exact: true }).click();
    await expectStep(page, "The edit bar");
    const bar = page.getByRole("region", { name: "Arrange the dashboard" });
    await expect(bar).toBeVisible();

    await nextTo(page, "Move, resize and remove");
    await nextTo(page, "Keep it or put it back");
    // Nothing changed, so Cancel leaves without asking.
    await bar.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(bar).toBeHidden();
    await expectStep(page, "Make it yours");
    await finish(page, "Make it yours");
    await expectViewed(page, "Arranging the dashboard");
  });

  test("on a phone, the palette tour skips the keyboard steps", async ({
    authedPage: page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await startTour(page, "Command palette", "Find anything from one box");
    await nextTo(page, "One shortcut to remember");
    await finish(page, "One shortcut to remember");
  });
});
