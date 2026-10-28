import { test, expect } from "../fixtures";
import { createAccount, createTransaction } from "../helpers/factories";
import { uniqueId } from "../helpers/api";

// Transactions run through a tabbed normal/split/transfer form. The payee field
// is a custom-value combobox that's awkward to drive, so create/edit identify
// the transaction by a distinctive amount (the CurrencyInput drives cleanly)
// rather than a payee; the edit target seeds its payee via the API for a stable
// row handle. Date defaults to today.
test.describe("Transactions", () => {
  test("creates a transaction through the UI", async ({
    authedPage: page,
    api,
  }) => {
    const account = await createAccount(api, {
      name: `Txn Account ${uniqueId()}`,
    });

    await page.goto("/transactions?basis=cash");
    await page
      .getByRole("button", { name: /new transaction/i })
      .first()
      .click();

    const dialog = page.getByRole("dialog");
    await dialog.getByLabel(/^account$/i).selectOption({ value: account.id });
    await dialog
      .getByLabel(/amount/i)
      .first()
      .fill("987.65");
    await dialog.getByRole("button", { name: /create transaction/i }).click();

    await expect(page.locator("tr", { hasText: "987.65" })).toBeVisible();
    await page.reload();
    await expect(page.locator("tr", { hasText: "987.65" })).toBeVisible();
  });

  test("lists transactions seeded via the API", async ({
    authedPage: page,
    api,
  }) => {
    const account = await createAccount(api);
    const coffee = await createTransaction(api, {
      accountId: account.id,
      payeeName: `Coffee ${uniqueId()}`,
    });
    const rent = await createTransaction(api, {
      accountId: account.id,
      payeeName: `Rent ${uniqueId()}`,
    });

    await page.goto("/transactions?basis=cash");

    await expect(
      page.locator("tr", { hasText: coffee.payeeName! }),
    ).toBeVisible();
    await expect(
      page.locator("tr", { hasText: rent.payeeName! }),
    ).toBeVisible();
  });

  test("edits a transaction through the UI", async ({
    authedPage: page,
    api,
  }) => {
    const account = await createAccount(api);
    const payeeName = `Edit Me ${uniqueId()}`;
    await createTransaction(api, {
      accountId: account.id,
      amount: 73.19,
      payeeName,
    });

    await page.goto("/transactions?basis=cash");

    const dialog = page.getByRole("dialog");
    // Clicking the row opens the edit modal; the amount cell doesn't stop
    // propagation (unlike the payee/category/action cells). first() since the
    // running-balance cell shows the same value for a single transaction.
    // The list is client-rendered, so a click that lands before the row's
    // handler hydrates is a no-op -- retry the click until the dialog opens
    // rather than clicking once into the void.
    await expect(async () => {
      await page
        .locator("tr", { hasText: payeeName })
        .getByText(/73\.19/)
        .first()
        .click();
      await expect(dialog).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 30000 });

    await dialog
      .getByLabel(/amount/i)
      .first()
      .fill("88.88");
    await dialog.getByRole("button", { name: /update transaction/i }).click();

    await expect(page.locator("tr", { hasText: payeeName })).toContainText(
      "88.88",
    );
    await page.reload();
    await expect(page.locator("tr", { hasText: payeeName })).toContainText(
      "88.88",
    );
  });

  test("deletes a transaction through the UI", async ({
    authedPage: page,
    api,
  }) => {
    const account = await createAccount(api);
    const txn = await createTransaction(api, {
      accountId: account.id,
      payeeName: `Delete Me ${uniqueId()}`,
    });

    await page.goto("/transactions?basis=cash");

    // The list is client-rendered, so a click that lands before the row's
    // delete handler hydrates is a no-op -- retry the click until the confirm
    // dialog opens rather than clicking once into the void.
    const dialog = page.getByRole("dialog");
    await expect(async () => {
      await page
        .locator("tr", { hasText: txn.payeeName! })
        .getByRole("button", { name: "Delete", exact: true })
        .click();
      await expect(dialog).toBeVisible({ timeout: 2000 });
    }).toPass({ timeout: 30000 });

    await dialog.getByRole("button", { name: "Delete", exact: true }).click();

    await expect(page.locator("tr", { hasText: txn.payeeName! })).toHaveCount(
      0,
    );

    // The confirm triggers a background list refetch. Firefox can reject
    // reload() with NS_ERROR_FAILURE when it fires while that request is still
    // in flight (the navigation aborts it), so retry the reload until it lands.
    await expect(async () => {
      await page.reload();
    }).toPass({ timeout: 30000 });
    await expect(page.locator("tr", { hasText: txn.payeeName! })).toHaveCount(
      0,
    );
  });

  test("rejects a transaction with no amount", async ({
    authedPage: page,
    api,
  }) => {
    // Seed an account so the form opens normally; amount is still required.
    await createAccount(api);

    await page.goto("/transactions?basis=cash");
    await page
      .getByRole("button", { name: /new transaction/i })
      .first()
      .click();

    const dialog = page.getByRole("dialog");
    await dialog.getByRole("button", { name: /create transaction/i }).click();

    await expect(dialog.getByText(/amount is required/i)).toBeVisible();
  });
});

// Sorting the register (issue #521). The account filter is what makes the
// Balance column appear at all, so these seed one account and reach it through
// the URL the account page links to, rather than driving the filter panel.
test.describe("Register sorting", () => {
  test("sorts by a column, and hides the balance while it is not by date", async ({
    authedPage: page,
    api,
  }) => {
    const account = await createAccount(api, {
      name: `Sort Account ${uniqueId()}`,
    });
    const alpha = `AAA Payee ${uniqueId()}`;
    const zulu = `ZZZ Payee ${uniqueId()}`;
    await createTransaction(api, {
      accountId: account.id,
      amount: -10,
      payeeName: zulu,
      transactionDate: "2026-01-01",
    });
    await createTransaction(api, {
      accountId: account.id,
      amount: -20,
      payeeName: alpha,
      transactionDate: "2026-01-02",
    });

    await page.goto(`/transactions?basis=cash&accountIds=${account.id}`);

    // Scoped to the register: the page also draws a chart and a filter panel
    // above it, and a future table mounted between them would silently
    // redirect a bare `tbody tr`.
    const registerRows = page.locator("table tbody tr").first();

    // Date order is the default, and it is what a balance means anything in.
    const balanceHeader = page.getByRole("columnheader", {
      name: /^balance$/i,
    });
    await expect(balanceHeader).toBeVisible();
    const dateHeader = page.getByRole("columnheader", { name: /^date/i });
    await expect(dateHeader).toHaveAttribute("aria-sort", "descending");

    // Sorting by payee puts AAA first and takes the balance away, naming the
    // way back rather than leaving the column silently missing.
    await page.getByRole("columnheader", { name: /^payee$/i }).click();
    await expect(
      page.getByRole("columnheader", { name: /^payee$/i }),
    ).toHaveAttribute("aria-sort", "ascending");
    await expect(balanceHeader).toBeHidden();
    await expect(
      page.getByText(/sort by date to see the running balance/i),
    ).toBeVisible();
    await expect(registerRows).toContainText(alpha);

    // The choice survives a reload, like the row density does -- and it is
    // re-sent to the server, which the rows are what prove.
    await page.reload();
    await expect(
      page.getByRole("columnheader", { name: /^payee$/i }),
    ).toHaveAttribute("aria-sort", "ascending");
    await expect(registerRows).toContainText(alpha);
    await expect(balanceHeader).toBeHidden();
  });

  test("shows a row the same balance in either date direction", async ({
    authedPage: page,
    api,
  }) => {
    const account = await createAccount(api, {
      name: `Balance Order ${uniqueId()}`,
      openingBalance: 1000,
    });
    const older = `Older ${uniqueId()}`;
    const newer = `Newer ${uniqueId()}`;
    await createTransaction(api, {
      accountId: account.id,
      amount: -10,
      payeeName: older,
      transactionDate: "2026-01-01",
    });
    await createTransaction(api, {
      accountId: account.id,
      amount: -20,
      payeeName: newer,
      transactionDate: "2026-01-02",
    });

    await page.goto(`/transactions?basis=cash&accountIds=${account.id}`);

    // The whole row, which is the balance plus the date, payee and amount that
    // reversing the register cannot change. Comparing it whole is what makes
    // this an assertion about the BALANCE: everything else in it is already
    // known to be identical, so a difference can only be the balance.
    const rowText = async (payee: string) => {
      const row = page.locator("tr", { hasText: payee });
      await expect(row).toBeVisible();
      return row.innerText();
    };

    const olderDescending = await rowText(older);
    const newerDescending = await rowText(newer);

    // Reverse the register from the keyboard, not with a click. The Date
    // header holds the year toggle, and that control's wrapper stops the event
    // before it reaches the header -- deliberately, so pressing it does not
    // also sort -- and the toggle is what Playwright's click lands on, because
    // a click with no position goes to the centre of the cell. Enter reaches
    // the header's own handler with no hit-testing at all: the `<th>` carries
    // tabIndex and an activateOnKey handler for exactly this. The mouse path
    // is covered by the Payee header above, which holds no control.
    const dateHeader = page.getByRole("columnheader", { name: /^date/i });
    await dateHeader.press("Enter");
    await expect(dateHeader).toHaveAttribute("aria-sort", "ascending");
    await expect(page.locator("table tbody tr").first()).toContainText(older);

    expect(await rowText(older)).toBe(olderDescending);
    expect(await rowText(newer)).toBe(newerDescending);
  });
});

// Hideable columns (issue #1708): the register's "Columns" menu hides a
// column from the DOM at every width and this browser remembers the choice
// across a reload; the menu is also the one way to bring it back.
test.describe("Hideable columns", () => {
  test("hides a register column through the menu, keeps it hidden across a reload, and restores it", async ({
    authedPage: page,
    api,
  }) => {
    const account = await createAccount(api, {
      name: `Hideable Register ${uniqueId()}`,
    });
    await createTransaction(api, {
      accountId: account.id,
      payeeName: `Hideable Row ${uniqueId()}`,
    });

    await page.goto(`/transactions?basis=cash&accountIds=${account.id}`);

    const statusHeader = page.getByRole("columnheader", { name: /^status$/i });
    await expect(statusHeader).toBeVisible();

    await page.getByRole("button", { name: /^columns\b/i }).click();
    const menu = page.getByRole("menu", { name: /show or hide columns/i });
    // The choice is saved to this browser's localStorage synchronously
    // (useHiddenColumnsStore), so the reload below reads it back.
    await menu.getByRole("menuitemcheckbox", { name: /^status$/i }).click();

    await expect(statusHeader).toHaveCount(0);

    await page.reload();
    await expect(statusHeader).toHaveCount(0);

    await page.getByRole("button", { name: /^columns\b/i }).click();
    await menu.getByRole("menuitemcheckbox", { name: /^status$/i }).click();

    await expect(statusHeader).toBeVisible();
  });
});
