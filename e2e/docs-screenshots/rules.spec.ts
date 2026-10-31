import {
  test,
  expect,
  type BrowserContext,
  type Locator,
  type Page,
} from "@playwright/test";
import { apiFor, scrollUnderHeader, waitForReady } from "../readme/session";
import { STATE_FILE } from "../readme/settings";
import { docShot, openDocsSession } from "./capture";

// website/docs/rules.md. The rules are the showcase rules readme/01-seed.spec.ts
// adds (readme/seed-tags-rules.ts). Nothing is saved or run: the new rule is
// built in the editor and left with Cancel, the tests and the run dialog's
// preview only read, and every dialog is closed without confirming.

// A first visit to a route compiles it on the development server: minutes, not seconds.
test.describe.configure({ timeout: 360_000 });

let context: BrowserContext;
let page: Page;
let coffeeRule: string;
let costcoRule: string;

interface Named {
  id: string;
  name: string;
}

test.beforeAll(async ({ browser }) => {
  context = await openDocsSession(browser);
  page = await context.newPage();
  await page.goto("/dashboard");
  const rules = await apiFor(page).get<Named[]>("/transaction-rules");
  const coffee = rules.find((r) => r.name === "Coffee runs");
  const costco = rules.find((r) => r.name === "Costco receipts");
  if (!coffee || !costco)
    throw new Error(
      "The showcase rules are missing: run readme/01-seed.spec.ts.",
    );
  coffeeRule = coffee.id;
  costcoRule = costco.id;
});

/**
 * Keep the shared session file current. The server rotates the sign-in cookies
 * as a context refreshes them, so a later context (the next file, or a worker
 * restarted after a failure) would otherwise start from cookies that no longer
 * work.
 */
const saveSession = () =>
  context.storageState({ path: STATE_FILE }).catch(() => undefined);

test.afterEach(saveSession);

test.afterAll(async () => {
  await saveSession();
  await context.close();
});

/**
 * Open `path` and wait for it to settle. The development server compiles a
 * route on its first visit, and the service worker answers a navigation that
 * takes too long with its offline page, so a first attempt can land there.
 * `ready`, when given, is what the page shows once its data has loaded.
 */
async function go(p: Page, path: string, ready?: Locator): Promise<void> {
  await expect(async () => {
    await p.goto(path);
    await expect(p.getByRole("main").first()).toBeVisible({ timeout: 20_000 });
    // A request the busy server dropped shows an error card: load the page again.
    if (ready) await expect(ready).toBeVisible({ timeout: 30_000 });
  }).toPass({ timeout: 300_000 });
  await waitForReady(p);
}

/** The editor's sections are regions named by their headings. */
const section = (p: Page, name: string) =>
  p.getByRole("region", { name, exact: true });

/**
 * A new rule, built in the editor and never saved: restaurant meals of $50 or
 * more on a Friday or Saturday, or ones already tagged Date night, get the
 * Date night tag and a description naming the restaurant.
 */
async function buildDraft(p: Page): Promise<void> {
  await go(p, "/rules/new", p.getByRole("heading", { name: "New rule" }));
  await p.getByLabel("Name").fill("Restaurant meals over $50");

  const ifSection = section(p, "If");
  const conditions = ifSection.getByRole("group", {
    name: "Condition",
    exact: true,
  });
  await ifSection
    .getByRole("button", { name: "+ Add condition" })
    .first()
    .click();
  await conditions
    .nth(0)
    .getByLabel("Field")
    .selectOption({ label: "Category" });
  // The category picker opens its list where the box is, so the box is on screen first.
  const category = conditions.nth(0).getByPlaceholder("Choose a category");
  await category.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await category.click();
  await category.pressSequentially("Restau", { delay: 50 });
  await p.getByText("Food: Restaurants", { exact: true }).click();

  await ifSection
    .getByRole("button", { name: "+ Add condition" })
    .first()
    .click();
  await conditions
    .nth(1)
    .getByLabel("Field")
    .selectOption({ label: "Amount (ignoring sign)" });
  await conditions
    .nth(1)
    .getByLabel("Operator")
    .selectOption({ label: "is at least" });
  await conditions.nth(1).getByLabel("Amount").fill("50");

  // A nested group: either of two conditions.
  await ifSection.getByRole("button", { name: "+ Add group" }).first().click();
  const group = ifSection.getByRole("group", { name: "Group", exact: true });
  await group.getByRole("button", { name: "Any of these" }).click();
  const inner = group.getByRole("group", { name: "Condition", exact: true });
  await group.getByRole("button", { name: "+ Add condition" }).click();
  await inner
    .nth(0)
    .getByLabel("Field")
    .selectOption({ label: "Day of the week" });
  await inner
    .nth(0)
    .getByLabel("Operator")
    .selectOption({ label: "is any of" });
  // The new condition starts on Monday.
  await inner.nth(0).getByRole("button", { name: "Mon", exact: true }).click();
  await p.getByRole("checkbox", { name: "Fri" }).click();
  await p.getByRole("checkbox", { name: "Sat" }).click();
  await p.getByRole("checkbox", { name: "Mon" }).click();
  await p.keyboard.press("Escape");
  await group.getByRole("button", { name: "+ Add condition" }).click();
  await inner.nth(1).getByLabel("Field").selectOption({ label: "Tags" });
  await inner.nth(1).getByRole("button", { name: "Choose tags" }).click();
  await p.getByRole("checkbox", { name: "Date night" }).click();
  await p.keyboard.press("Escape");

  const thenSection = section(p, "Then");
  const actions = thenSection.getByRole("group", {
    name: "Action",
    exact: true,
  });
  await thenSection.getByRole("button", { name: "+ Add action" }).click();
  await actions
    .nth(0)
    .getByLabel("Action type")
    .selectOption({ label: "Add tags" });
  await actions.nth(0).getByRole("button", { name: "Choose tags" }).click();
  await p.getByRole("checkbox", { name: "Date night" }).click();
  await p.keyboard.press("Escape");

  await thenSection.getByRole("button", { name: "+ Add action" }).click();
  await actions
    .nth(1)
    .getByLabel("Action type")
    .selectOption({ label: "Set the description" });
  await actions
    .nth(1)
    .getByLabel("Description text")
    .fill("Dinner at {payeeText}");
}

test("rules-list", async () => {
  await go(page, "/rules", page.getByText("Costco receipts"));
  await docShot(page, "rules-list");
});

test("rules-row-menu", async () => {
  await go(page, "/rules", page.getByText("Costco receipts"));
  await page
    .getByRole("row", { name: /Coffee runs/ })
    .getByRole("button", { name: "More actions" })
    .click();
  await expect(
    page.getByRole("menuitem", { name: "Run on existing transactions" }),
  ).toBeVisible();
  await docShot(page, "rules-row-menu");
  await page.keyboard.press("Escape");
});

test("rules-run-dialog", async () => {
  await go(page, "/rules", page.getByText("Costco receipts"));
  await page
    .getByRole("row", { name: /Coffee runs/ })
    .getByRole("button", { name: "More actions" })
    .click();
  await page
    .getByRole("menuitem", { name: "Run on existing transactions" })
    .click();
  const dialog = page.getByRole("dialog");
  await expect(
    dialog.getByRole("heading", {
      name: 'Run "Coffee runs" on existing transactions',
    }),
  ).toBeVisible();
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(dialog.getByText(/would change out of/)).toBeVisible({
    timeout: 60_000,
  });
  await waitForReady(page);
  await docShot(page, "rules-run-dialog", dialog);
  await dialog.getByRole("button", { name: "Cancel" }).click();
});

test("rules-editor", async () => {
  await go(
    page,
    `/rules/${costcoRule}`,
    page.getByRole("heading", { name: "Edit rule" }),
  );
  await expect(page.getByLabel("Name")).toHaveValue("Costco receipts");
  await waitForReady(page);
  await docShot(page, "rules-editor");
});

test("rules-conditions", async () => {
  await buildDraft(page);
  await waitForReady(page);
  await scrollUnderHeader(
    page,
    page.getByRole("heading", { name: "If", exact: true }),
  );
  await docShot(page, "rules-conditions");
});

test("rules-expression", async () => {
  await buildDraft(page);
  await section(page, "If")
    .getByRole("button", { name: "Expression", exact: true })
    .click();
  await expect(page.getByLabel("Condition expression")).toBeVisible();
  await waitForReady(page);
  await scrollUnderHeader(
    page,
    page.getByRole("heading", { name: "If", exact: true }),
  );
  await docShot(page, "rules-expression");
});

test("rules-actions", async () => {
  await buildDraft(page);
  await waitForReady(page);
  await scrollUnderHeader(
    page,
    page.getByRole("heading", { name: "Then", exact: true }),
  );
  await docShot(page, "rules-actions");
});

test("rules-test-match", async () => {
  await buildDraft(page);
  await section(page, "If")
    .getByRole("button", { name: "Test rule conditions" })
    .click();
  const summary = page.getByTestId("rule-match-summary");
  await expect(summary).toHaveText(/matching transaction/, { timeout: 60_000 });
  await waitForReady(page);
  await scrollUnderHeader(
    page,
    section(page, "If").getByRole("button", { name: "Test rule conditions" }),
  );
  await docShot(page, "rules-test-match");
});

test("rules-test-panel", async () => {
  await buildDraft(page);
  const testSection = section(page, "Test");
  await testSection
    .getByRole("button", { name: "Test rule", exact: true })
    .click();
  await expect(testSection.getByText(/would change out of/)).toBeVisible({
    timeout: 60_000,
  });
  await waitForReady(page);
  await docShot(page, "rules-test-panel", testSection);
});

test("rules-history", async () => {
  await go(
    page,
    `/rules/${coffeeRule}`,
    page.getByRole("heading", { name: "Edit rule" }),
  );
  const history = section(page, "History");
  // The demo data's own rows were written before the rules existed, so the
  // history holds what other captures created since, or says it is empty.
  await expect(
    history
      .getByRole("table")
      .or(history.getByText("This rule has not changed anything yet")),
  ).toBeVisible({
    timeout: 30_000,
  });
  await waitForReady(page);
  await docShot(page, "rules-history", history);
});

test("rules-split-action", async () => {
  await go(page, "/rules/new", page.getByRole("heading", { name: "New rule" }));
  await page.getByLabel("Name").fill("Mortgage payment from the bank text");

  // The pattern keeps the two amounts of the bank's line as captures.
  const ifSection = section(page, "If");
  const condition = ifSection
    .getByRole("group", { name: "Condition", exact: true })
    .first();
  await ifSection
    .getByRole("button", { name: "+ Add condition" })
    .first()
    .click();
  await condition.getByLabel("Field").selectOption({ label: "Description" });
  await condition
    .getByLabel("Operator")
    .selectOption({ label: "matches the pattern" });
  await condition
    .getByLabel("Value")
    .fill("*PRINCIPAL: {principal} INTEREST: {interest}*");

  const thenSection = section(page, "Then");
  await thenSection.getByRole("button", { name: "+ Add action" }).click();
  const action = thenSection.getByRole("group", {
    name: "Action",
    exact: true,
  });
  await action
    .getByLabel("Action type")
    .selectOption({ label: "Split transaction" });
  const principal = action.getByRole("group", { name: "Split 1", exact: true });
  await principal.getByLabel("Amount").selectOption({ label: "{principal}" });
  await principal.getByLabel("Type").selectOption({ label: "Transfer" });
  await principal
    .getByLabel("Account")
    .selectOption({ label: "Home Mortgage (CAD)" });
  const interest = action.getByRole("group", { name: "Split 2", exact: true });
  await interest.getByLabel("Amount").selectOption({ label: "{interest}" });
  const category = interest.getByPlaceholder("Select category...");
  await category.evaluate((el) => el.scrollIntoView({ block: "center" }));
  await category.click();
  await category.pressSequentially("Mortgage Int", { delay: 50 });
  await page.getByText("Housing: Mortgage Interest", { exact: true }).click();

  await waitForReady(page);
  // The card is taller than the screen: its top, the guide and both parts.
  await scrollUnderHeader(page, action);
  await docShot(page, "rules-split-action");
});
