import { join } from "node:path";
import {
  test,
  expect,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { waitForReady } from "../readme/session";
import { docShot, openDocsSession } from "./capture";
import { MNY_FIXTURES, leaveWizard, openImport } from "./import-files";

// website/docs/importing-from-microsoft-money.md, the direct .mny import. The
// file is read and previewed, and the wizard is left before Start import:
// nothing is imported into the demo data. The QIF steps on that page are
// taken by importing-transactions.spec.ts.

let context: BrowserContext;
let page: Page;

/** A Money 99 file with banking, investments, a loan and scheduled bills. */
const MONEY_99 = join(MNY_FIXTURES, "sample-money99.mny");
/** The one fixture that really asks for a password. */
const MONEY_PLUS_PASSWORD = join(MNY_FIXTURES, "money2008-pwd.mny");

/** Reading and previewing a whole Money profile takes a while. */
const PARSE_TIMEOUT = 90_000;

test.beforeAll(async ({ browser }) => {
  context = await openDocsSession(browser);
  page = await context.newPage();
});

test.afterAll(async () => {
  await context.close();
});

/** A section of the review step, by its heading. */
function sectionOf(heading: Locator): Locator {
  return heading.locator(
    'xpath=ancestor::div[contains(concat(" ", normalize-space(@class), " "), " mb-6 ")][1]',
  );
}

test("import-mny-password", async () => {
  await openImport(page);
  await page.locator('input[type="file"]').setInputFiles(MONEY_PLUS_PASSWORD);
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", { name: "This Money file needs a password" }),
  ).toBeVisible({ timeout: PARSE_TIMEOUT });
  await expect(page.locator(".animate-spin")).toHaveCount(0);
  await docShot(page, "import-mny-password", dialog);
  await leaveWizard(page);
});

test.describe("the Money review step", () => {
  test.describe.configure({ mode: "serial" });

  test("import-mny-review", async () => {
    await openImport(page);
    await page.locator('input[type="file"]').setInputFiles(MONEY_99);
    const heading = page.getByRole("heading", {
      name: "Review your Microsoft Money file",
    });
    await expect(heading).toBeVisible({ timeout: PARSE_TIMEOUT });
    await waitForReady(page);
    await docShot(page, "import-mny-review");
  });

  test("import-mny-accounts", async () => {
    const section = sectionOf(
      page.getByRole("heading", { name: /^Accounts \(\d+\)$/ }),
    );
    await section.scrollIntoViewIfNeeded();
    await docShot(page, "import-mny-accounts", section);
  });

  test("import-mny-bills", async () => {
    const section = sectionOf(
      page.getByRole("heading", { name: /^Scheduled bills to create/ }),
    );
    await section.scrollIntoViewIfNeeded();
    await docShot(page, "import-mny-bills", section);
  });

  test("import-mny-options", async () => {
    const card = sectionOf(
      page.getByRole("heading", { name: "Import options" }),
    );
    await card.scrollIntoViewIfNeeded();
    await docShot(page, "import-mny-options", card);
  });

  test("import-mny-notes", async () => {
    const section = sectionOf(
      page.getByRole("heading", { name: "Notes about this file" }),
    );
    await section.scrollIntoViewIfNeeded();
    await docShot(page, "import-mny-notes", section);
  });

  test("import-mny-start-fresh", async () => {
    // Ticking "Start fresh" makes Start import ask first; the dialog is
    // cancelled, so nothing is removed and nothing is imported.
    await page.getByRole("checkbox", { name: /Start fresh/ }).check();
    await page.getByRole("button", { name: "Start import" }).click();
    const dialog = page.getByRole("dialog");
    await expect(
      dialog.getByRole("heading", { name: "Remove Existing Data" }),
    ).toBeVisible();
    await docShot(page, "import-mny-start-fresh", dialog);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole("checkbox", { name: /Start fresh/ }).uncheck();
    await leaveWizard(page);
  });
});
