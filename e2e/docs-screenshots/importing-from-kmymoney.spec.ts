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
import { KMY_FIXTURES, leaveWizard, openImport } from "./import-files";

// website/docs/importing-from-kmymoney.md, the direct .kmy import. The file is
// read and previewed, and the wizard is left before Start import: nothing is
// imported into the demo data.

let context: BrowserContext;
let page: Page;

/**
 * The committed, hand-written KMyMoney file: a checking account, a euro
 * savings account, an investment pair, a payee with a match key and a default
 * category, a schedule and prices.
 */
const KMY_SAMPLE = join(KMY_FIXTURES, "sample-synthetic.kmy");

/** Reading and previewing a whole profile takes a while. */
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

test.describe("the KMyMoney review step", () => {
  test.describe.configure({ mode: "serial" });

  test("import-kmy-review", async () => {
    await openImport(page);
    await page.locator('input[type="file"]').setInputFiles(KMY_SAMPLE);
    const heading = page.getByRole("heading", {
      name: "Review your KMyMoney file",
    });
    await expect(heading).toBeVisible({ timeout: PARSE_TIMEOUT });
    await waitForReady(page);
    await docShot(page, "import-kmy-review");
  });

  test("import-kmy-accounts", async () => {
    const section = sectionOf(
      page.getByRole("heading", { name: /^Accounts \(\d+\)$/ }),
    );
    await section.scrollIntoViewIfNeeded();
    await docShot(page, "import-kmy-accounts", section);
  });

  test("import-kmy-bills", async () => {
    const section = sectionOf(
      page.getByRole("heading", { name: /^Scheduled transactions to create/ }),
    );
    await section.scrollIntoViewIfNeeded();
    await docShot(page, "import-kmy-bills", section);
  });

  test("import-kmy-options", async () => {
    const card = sectionOf(
      page.getByRole("heading", { name: "Import options" }),
    );
    await card.scrollIntoViewIfNeeded();
    await docShot(page, "import-kmy-options", card);
  });

  test("import-kmy-notes", async () => {
    const section = sectionOf(
      page.getByRole("heading", { name: "Notes about this file" }),
    );
    await section.scrollIntoViewIfNeeded();
    await docShot(page, "import-kmy-notes", section);
    await leaveWizard(page);
  });
});
