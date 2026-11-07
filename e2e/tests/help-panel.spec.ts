import type { Page } from "@playwright/test";
import { test, expect } from "../fixtures";

// A page prefetches the guide's manifest when its header mounts, and a click
// before the answer arrives is left to the link (monize.net), by design: the
// choice is made synchronously at click time. Go to the page and wait for the
// manifest, so the click that follows is the one a reader makes a moment later.
async function gotoWithGuideKnown(page: Page, path: string) {
  const manifest = page.waitForResponse(
    (r) => new URL(r.url()).pathname.endsWith("/help") && r.ok(),
  );
  await page.goto(path);
  await (await manifest).finished();
  // The app stores the answer a tick after the body is read; one frame covers it.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(resolve)),
  );
}

// The page header's "?" opens the user guide in a panel beside the page instead
// of in a new browser tab. The guide ships in the backend (the e2e stack builds
// the development image, which copies website/docs and its screenshots), so this
// runs offline.
test.describe("Help panel", () => {
  test('the Budgets "?" opens the Budgets guide in place, with no new tab', async ({
    authedPage: page,
    context,
  }) => {
    await gotoWithGuideKnown(page, "/budgets");
    await expect(
      page.getByRole("heading", { level: 1, name: "Budgets" }),
    ).toBeVisible();

    // Any page the click opens, whatever it is, is a regression.
    const opened: string[] = [];
    context.on("page", (p) => opened.push(p.url()));

    await page.getByRole("link", { name: "Help for this page" }).click();

    const panel = page.getByRole("complementary", { name: "Help" });
    await expect(panel).toBeVisible();
    await expect(
      panel.getByRole("heading", { level: 2, name: "Budgets", exact: true }),
    ).toBeVisible();
    await expect(panel.getByText("Creating a Budget").first()).toBeVisible();

    // The budgets list is still on screen beside it.
    await expect(
      page.getByRole("heading", { level: 1, name: "Budgets" }),
    ).toBeVisible();
    expect(opened).toEqual([]);
    expect(page.url()).toMatch(/\/budgets$/);
  });

  test("a screenshot loads in the panel from the backend, as WebP", async ({
    authedPage: page,
  }) => {
    await gotoWithGuideKnown(page, "/budgets");
    // The development image the e2e stack runs bundles the screenshots as WebP,
    // the format production ships; the request stays on the app's own origin.
    const picture = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname.startsWith(
          "/api/v1/help/images/budgets-page",
        ) && r.ok(),
    );
    await page.getByRole("link", { name: "Help for this page" }).click();

    const panel = page.getByRole("complementary", { name: "Help" });
    const img = panel.getByRole("img", {
      name: /^The Budgets page, listing each budget/,
    });
    await img.scrollIntoViewIfNeeded();

    const response = await picture;
    expect(new URL(response.url()).origin).toBe(new URL(page.url()).origin);
    expect(response.headers()["content-type"]).toBe("image/webp");
    await expect
      .poll(() =>
        img.evaluate((el: HTMLImageElement) =>
          el.complete ? el.naturalWidth : 0,
        ),
      )
      .toBeGreaterThan(0);
    // The caption and the way to the same picture on monize.net stay with it.
    await expect(
      panel
        .getByRole("link", { name: "View screenshot on monize.net" })
        .first(),
    ).toBeVisible();
  });

  test("an internal link navigates inside the panel, and Back returns", async ({
    authedPage: page,
  }) => {
    await gotoWithGuideKnown(page, "/budgets");
    await page.getByRole("link", { name: "Help for this page" }).click();

    const panel = page.getByRole("complementary", { name: "Help" });
    await expect(
      panel.getByRole("heading", { level: 2, name: "Budgets", exact: true }),
    ).toBeVisible();

    // budgets.md links to the Budget reports section of the Reports page.
    await panel
      .getByRole("link", { name: "Reports", exact: true })
      .first()
      .click();
    await expect(
      panel.getByRole("heading", { level: 2, name: "Reports", exact: true }),
    ).toBeVisible();
    expect(page.url()).toMatch(/\/budgets$/);

    await panel.getByRole("button", { name: "Back" }).click();
    await expect(
      panel.getByRole("heading", { level: 2, name: "Budgets", exact: true }),
    ).toBeVisible();
  });

  test("Escape closes the panel, and the icon is still a link to monize.net", async ({
    authedPage: page,
  }) => {
    await gotoWithGuideKnown(page, "/budgets");
    const help = page.getByRole("link", { name: "Help for this page" });

    // The icon is still a link to the same page on monize.net.
    await expect(help).toHaveAttribute(
      "href",
      "https://www.monize.net/docs/budgets",
    );

    await help.click();
    const panel = page.getByRole("complementary", { name: "Help" });
    await expect(panel).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
  });

  test("a key that names a section opens the panel at that section", async ({
    authedPage: page,
  }) => {
    // `institutions` is { page: 'accounts', section: 'financial-institutions' }.
    await gotoWithGuideKnown(page, "/institutions");
    await expect(
      page.getByRole("heading", { level: 1, name: "Institutions" }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Help for this page" }).click();

    const panel = page.getByRole("complementary", { name: "Help" });
    await expect(
      panel.getByRole("heading", { level: 2, name: "Accounts", exact: true }),
    ).toBeVisible();
    const section = panel.getByRole("heading", {
      name: "Financial Institutions",
      exact: true,
    });
    await expect(section).toBeVisible();
    // Focus lands on the section, not the top of the page.
    await expect(section).toBeFocused();
    expect(page.url()).toMatch(/\/institutions$/);
  });

  test("a Ctrl-click goes to monize.net in a new tab and leaves the panel closed", async ({
    authedPage: page,
    context,
  }) => {
    // Nothing may reach the network: record the request the new tab makes and
    // refuse it.
    const requested: string[] = [];
    await context.route("https://www.monize.net/**", (route) => {
      requested.push(route.request().url());
      return route.abort();
    });

    await gotoWithGuideKnown(page, "/budgets");
    await expect(
      page.getByRole("heading", { level: 1, name: "Budgets" }),
    ).toBeVisible();

    const popup = context.waitForEvent("page");
    await page
      .getByRole("link", { name: "Help for this page" })
      .click({ modifiers: ["Control"] });
    await popup;

    await expect
      .poll(() => requested)
      .toContain("https://www.monize.net/docs/budgets");
    await expect(
      page.getByRole("complementary", { name: "Help" }),
    ).toBeHidden();
    expect(page.url()).toMatch(/\/budgets$/);
  });
});
