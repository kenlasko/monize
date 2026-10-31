import { randomUUID } from "node:crypto";
import { test, expect, type BrowserContext, type Page } from "@playwright/test";
import type { ApiClient } from "../helpers/api";
import type { SharedGroupFixture } from "../helpers/shared-expenses";
import { apiFor } from "../readme/session";
import { addDays, STATE_FILE, todayYmd } from "../readme/settings";
import { docShot, openDocsSession } from "./capture";

// website/docs/shared-expenses.md. The demo data has no shared groups, so this
// file adds two through the API: a cabin weekend with four people, four
// purchases and one repayment, and a two-person household. Each is looked up by
// name first and created only when missing, so the second theme's run and every
// later run change nothing and the overview never lists a duplicate. No dialog
// is saved.

// A first visit to a route compiles it on the development server: minutes, not seconds.
test.describe.configure({ timeout: 360_000 });

const CABIN = "Lake cabin weekend";
const HOUSEHOLD = "Apartment bills";

let context: BrowserContext;
let page: Page;
let cabin: SharedGroupFixture;

test.beforeAll(async ({ browser }) => {
  context = await openDocsSession(browser);
  page = await context.newPage();
  await page.goto("/shared-expenses");
  const api = apiFor(page);
  cabin = await seedCabin(api);
  await seedHousehold(api);
});

/** Keep the shared session file current; see warranties.spec.ts. */
const saveSession = () =>
  context.storageState({ path: STATE_FILE }).catch(() => undefined);

test.afterEach(async () => {
  await saveSession();
});

test.afterAll(async () => {
  await saveSession();
  await context.close();
});

interface Purchase {
  title: string;
  amount: string;
  daysAgo: number;
  paidBy: string;
  /** Everyone in the group when absent. */
  sharedBy?: string[];
}

/** The active group called `name`, created with `people` when there is none. */
async function findOrCreateGroup(
  api: ApiClient,
  name: string,
  people: string[],
): Promise<{ group: SharedGroupFixture; created: boolean }> {
  const existing = (
    await api.get<{ id: string; name: string; archivedAt: string | null }[]>(
      "/shared-expenses/groups",
    )
  ).find((g) => g.name === name && !g.archivedAt);
  if (existing)
    return {
      group: await api.get<SharedGroupFixture>(
        `/shared-expenses/groups/${existing.id}`,
      ),
      created: false,
    };
  const result = await api.post<{ id: string }>("/shared-expenses/groups", {
    operationId: randomUUID(),
    name,
    myName: "Robert",
    currencyCode: "USD",
    participants: people.map((person) => ({ name: person })),
  });
  return {
    group: await api.get<SharedGroupFixture>(
      `/shared-expenses/groups/${result.id}`,
    ),
    created: true,
  };
}

function personId(group: SharedGroupFixture, name: string): string {
  const found = group.participants.find((p) => p.name === name);
  if (!found) throw new Error(`${group.id} has no participant ${name}.`);
  return found.id;
}

async function addPurchase(
  api: ApiClient,
  group: SharedGroupFixture,
  purchase: Purchase,
): Promise<void> {
  const sharedBy =
    purchase.sharedBy ?? group.participants.map((person) => person.name);
  await api.post(`/shared-expenses/groups/${group.id}/entries`, {
    operationId: randomUUID(),
    expectedRevision: 0,
    type: "EXPENSE",
    title: purchase.title,
    amount: purchase.amount,
    currencyCode: "USD",
    date: addDays(todayYmd(), -purchase.daysAgo),
    splitMode: "EQUAL",
    shares: sharedBy.map((name) => ({ participantId: personId(group, name) })),
    contributions: [
      {
        participantId: personId(group, purchase.paidBy),
        value: purchase.amount,
      },
    ],
  });
}

/**
 * Robert is owed $335.00 after Bartek's $50.00 repayment; Anna owes $75.00,
 * Bartek $85.00 and Chen $175.00. Robert did not go kayaking.
 */
async function seedCabin(api: ApiClient): Promise<SharedGroupFixture> {
  const { group, created } = await findOrCreateGroup(api, CABIN, [
    "Anna",
    "Bartek",
    "Chen",
  ]);
  if (!created) return group;
  for (const purchase of [
    { title: "Cabin rental", amount: "600", daysAgo: 6, paidBy: "Robert" },
    { title: "Groceries", amount: "180", daysAgo: 5, paidBy: "Anna" },
    {
      title: "Kayak rental",
      amount: "120",
      daysAgo: 4,
      paidBy: "Bartek",
      sharedBy: ["Anna", "Bartek", "Chen"],
    },
    {
      title: "Gas for the drive home",
      amount: "80",
      daysAgo: 3,
      paidBy: "Chen",
    },
  ])
    await addPurchase(api, group, purchase);
  const settled = await api.get<SharedGroupFixture>(
    `/shared-expenses/groups/${group.id}`,
  );
  await api.post(`/shared-expenses/groups/${group.id}/entries`, {
    operationId: randomUUID(),
    expectedRevision: 0,
    expectedGroupRevision: settled.financialRevision,
    type: "REPAYMENT",
    title: "Repayment",
    amount: "50",
    currencyCode: "USD",
    date: addDays(todayYmd(), -1),
    splitMode: "EQUAL",
    shares: [],
    contributions: [],
    fromParticipantId: personId(group, "Bartek"),
    toParticipantId: personId(group, "Robert"),
  });
  return api.get<SharedGroupFixture>(`/shared-expenses/groups/${group.id}`);
}

/** Robert owes Sam $12.00, so the overview shows both directions. */
async function seedHousehold(api: ApiClient): Promise<void> {
  const { group, created } = await findOrCreateGroup(api, HOUSEHOLD, ["Sam"]);
  if (!created) return;
  await addPurchase(api, group, {
    title: "Internet bill",
    amount: "70",
    daysAgo: 9,
    paidBy: "Sam",
  });
  await addPurchase(api, group, {
    title: "Hardware store",
    amount: "46",
    daysAgo: 2,
    paidBy: "Robert",
  });
}

async function openCabin(): Promise<void> {
  await page.goto(`/shared-expenses/${cabin.id}`);
  await expect(
    page.getByRole("heading", { name: CABIN, exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("row", { name: /Cabin rental/ })).toBeVisible();
}

async function openTab(name: string): Promise<void> {
  const tab = page.getByRole("tab", { name, exact: true });
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
}

async function openExpenseEditor() {
  await page.getByRole("button", { name: "Add Expense", exact: true }).click();
  await page.getByRole("button", { name: "Expense", exact: true }).click();
  return page.getByRole("dialog", { name: "Add Expense", exact: true });
}

test("shared-expenses-overview", async () => {
  await page.goto("/shared-expenses");
  await expect(
    page.getByRole("row", { name: /Lake cabin weekend/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("row", { name: /Apartment bills/ }),
  ).toBeVisible();
  await docShot(page, "shared-expenses-overview");
});

test("shared-expenses-new-group", async () => {
  await page.goto("/shared-expenses");
  await page
    .getByRole("button", { name: "New Group", exact: true })
    .first()
    .click();
  const form = page.getByRole("dialog", { name: "New Group", exact: true });
  await form.getByLabel("Group Name").fill("Ski trip");
  await form.getByLabel("Your Name").fill("Robert");
  // The form opens with one empty row for a person.
  const people = form.getByLabel("Person’s name");
  await people.first().fill("Anna");
  await form.getByRole("button", { name: "Add Person", exact: true }).click();
  await people.nth(1).fill("Bartek");
  await docShot(page, "shared-expenses-new-group", form);
});

test("shared-expenses-group", async () => {
  await openCabin();
  await docShot(page, "shared-expenses-group");
});

test("shared-expenses-expense", async () => {
  await openCabin();
  const editor = await openExpenseEditor();
  await editor.getByLabel("Description").fill("Dinner at the lodge");
  await editor.getByLabel("Amount", { exact: true }).fill("140");
  await editor.getByLabel("Description").click();
  await expect(
    editor.getByRole("button", { name: "Change Split", exact: true }),
  ).toBeVisible();
  await docShot(page, "shared-expenses-expense", editor);
});

test("shared-expenses-split", async () => {
  await openCabin();
  const editor = await openExpenseEditor();
  await editor.getByLabel("Description").fill("Dinner at the lodge");
  await editor.getByLabel("Amount", { exact: true }).fill("140");
  await editor.getByLabel("Description").click();
  await editor
    .getByRole("button", { name: "Change Split", exact: true })
    .click();
  const split = page.getByRole("dialog", {
    name: "Split Between",
    exact: true,
  });
  // Chen skipped dinner; the other three share it.
  await split.getByRole("switch", { name: "Chen", exact: true }).click();
  await expect(
    split.getByRole("switch", { name: "Chen", exact: true }),
  ).toHaveAttribute("aria-checked", "false");
  await expect(
    split.getByText("Ready to apply", { exact: true }),
  ).toBeVisible();
  await docShot(page, "shared-expenses-split", split);
});

test("shared-expenses-entry", async () => {
  await openCabin();
  await page.getByRole("row", { name: /Kayak rental/ }).click();
  const detail = page.getByRole("dialog", {
    name: "Kayak rental",
    exact: true,
  });
  await expect(
    detail.getByRole("button", { name: "Record Refund", exact: true }),
  ).toBeVisible();
  await docShot(page, "shared-expenses-entry", detail);
});

test("shared-expenses-balances", async () => {
  await openCabin();
  await openTab("Balances");
  await expect(
    page.getByRole("heading", { name: "Suggested Repayments", exact: true }),
  ).toBeVisible();
  await docShot(page, "shared-expenses-balances", page.getByRole("main"));
});

test("shared-expenses-repayment", async () => {
  await openCabin();
  await openTab("Balances");
  await page
    .getByRole("button", { name: "Record Repayment", exact: true })
    .first()
    .click();
  const editor = page.getByRole("dialog", {
    name: "Record Repayment",
    exact: true,
  });
  await expect(editor.getByLabel("From")).toBeVisible();
  await docShot(page, "shared-expenses-repayment", editor);
});

test("shared-expenses-settings", async () => {
  await openCabin();
  await openTab("Settings");
  await expect(
    page.getByRole("heading", { name: "People", exact: true }),
  ).toBeVisible();
  await docShot(page, "shared-expenses-settings", page.getByRole("main"));
});

test("shared-expenses-invite", async () => {
  await openCabin();
  await openTab("Settings");
  await page
    .getByRole("listitem")
    .filter({ has: page.getByText("Chen", { exact: true }) })
    .getByRole("button", { name: "Invite", exact: true })
    .click();
  const invite = page.getByRole("dialog", { name: "Invite", exact: true });
  await expect(
    invite.getByRole("button", { name: "Create Invitation", exact: true }),
  ).toBeVisible();
  await docShot(page, "shared-expenses-invite", invite);
});

test("shared-expenses-tour", async () => {
  await page.goto("/settings/tours");
  await page
    .getByRole("listitem")
    .filter({
      has: page.getByText("Shared expenses", { exact: true }),
    })
    .getByRole("button", { name: /^(Start|Retake)$/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "Share a trip, keep clear balances" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Open Shared Expenses", exact: true }),
  ).toBeVisible();
  await docShot(page, "shared-expenses-tour");
  await page.getByRole("button", { name: "End tour", exact: true }).click();
});
