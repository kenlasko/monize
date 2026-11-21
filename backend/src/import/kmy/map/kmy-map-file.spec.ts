import { AccountSubType } from "../../../accounts/entities/account.entity";
import { InvestmentAction } from "../../../securities/entities/investment-transaction.entity";
import { TransactionStatus } from "../../../transactions/entities/transaction.entity";
import {
  rawAccount,
  rawFile,
  rawPayee,
  rawSchedule,
  rawSecurity,
  rawTransaction,
  standardRoots,
  syntheticKmyFile,
} from "../__fixtures__/kmy-raw-builders";
import { mapKmyFile } from "./kmy-map-file";

const INPUT = {
  userDefaultCurrency: "CAD",
  phoneRegion: null,
  coinDecimals: new Map<string, number>(),
  asOf: "2026-06-01",
};

/** Row and split ids are random per run; everything else is compared. */
function strip(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (key, v) => {
      if (v instanceof Map) return [...v];
      if (v instanceof Set) return [...v];
      return key === "id" ||
        key === "linkedTransactionId" ||
        key === "linkedInvestmentId"
        ? undefined
        : v;
    }),
  );
}

describe("mapKmyFile: the reference's section 18 file", () => {
  const parsed = mapKmyFile(syntheticKmyFile(), INPUT);
  const account = (name: string) =>
    parsed.accounts.accounts.find((a) => a.name === name);

  it("describes the file as a KMyMoney one", () => {
    expect(parsed).toMatchObject({
      sourceFormat: "kmy",
      era: "unknown",
      passwordProtected: false,
      missingTables: [],
      missingFields: [],
      baseCurrency: "USD",
      kmyFile: {
        container: "xml",
        fixVersion: 12,
        appVersion: null,
        lastModified: null,
        asOf: "2026-06-01",
      },
    });
    expect(parsed.currencyCodes).toEqual(["USD", "EUR"]);
  });

  it("has the plan's accounts, opening balances and closed account", () => {
    expect(
      parsed.accounts.accounts.map((a) => [
        a.name,
        a.accountType,
        a.accountSubType,
        a.currencyCode,
        a.openingBalance,
        a.closed,
        a.closedDate,
        a.institutionName,
      ]),
    ).toEqual([
      ["Checking", "CHEQUING", null, "USD", 5000, false, null, "Example Bank"],
      ["EUR Savings", "SAVINGS", null, "EUR", 0, false, null, null],
      [
        "Brokerage Account - Cash",
        "INVESTMENT",
        AccountSubType.INVESTMENT_CASH,
        "USD",
        0,
        false,
        null,
        null,
      ],
      [
        "Brokerage Account - Brokerage",
        "INVESTMENT",
        AccountSubType.INVESTMENT_BROKERAGE,
        "USD",
        0,
        false,
        null,
        null,
      ],
      [
        "Old Savings",
        "SAVINGS",
        null,
        "USD",
        100,
        true,
        "2024-01-10",
        "Example Bank",
      ],
    ]);
    expect(account("Checking")?.description).toBe(
      "Main account\nsecond line of notes",
    );
  });

  it("has the plan's categories, payees, tags and scheduled bill", () => {
    expect(
      parsed.categories.categories.map((c) => [
        c.name,
        c.parentName,
        c.isIncome,
      ]),
    ).toEqual([
      ["Utilities", null, false],
      ["Groceries", null, false],
      ["Bank Fees", null, false],
      ["Dividends", null, true],
      ["Electricity", "11", false],
    ]);
    expect(parsed.payees.payees.map((p) => p.name)).toEqual([
      "Corner Market",
      "City Power",
    ]);
    expect(parsed.tags.tags.map((t) => t.name)).toEqual(["household"]);
    expect(parsed.bills.bills).toHaveLength(1);
    expect(parsed.bills.bills[0]).toMatchObject({
      name: "Electricity",
      frequency: "MONTHLY",
      nextDueDate: "2024-03-01",
      amount: -75,
      accountKey: account("Checking")?.key,
      categoryHandle: 12,
    });
    expect(parsed.options.bills).toEqual([1]);
  });

  it("has the plan's prices and rate", () => {
    expect(parsed.rawPrices.map((p) => [p.date, p.price])).toEqual([
      ["2024-02-10", 50],
      ["2024-05-01", 30],
    ]);
    expect(parsed.rawExchangeRates).toEqual([
      {
        fromCurrency: 1,
        toCurrency: 2,
        rate: 1.1,
        date: "2024-01-15",
        historical: true,
      },
    ]);
    expect([...parsed.currencyByHandle]).toEqual([
      [1, "EUR"],
      [2, "USD"],
    ]);
  });

  it("walks the investment example of spec 5.7.9", () => {
    expect(
      parsed.investments.transactions.map((r) => [
        r.action,
        r.quantity,
        r.totalAmount,
        r.commission,
        r.price,
        r.cashAmount,
        r.cashAccountKey,
        r.categoryHandle,
      ]),
    ).toEqual([
      [InvestmentAction.BUY, 10, 505, 5, 50, -505, "acct-9", null],
      [InvestmentAction.DIVIDEND, null, 7.5, 0, 7.5, 7.5, "acct-9", 15],
      [InvestmentAction.SPLIT, 2, 0, 0, null, 0, null, null],
      [InvestmentAction.SELL, 5, 145, 5, 30, 145, "acct-9", null],
    ]);
    expect(parsed.investments.transfersPaired).toBe(0);
    expect(parsed.holdingChecks).toEqual([
      {
        accountKey: "acct-8",
        securityHandle: 1,
        symbol: "EXC",
        lotQuantity: 15,
        replayQuantity: 15,
        delta: 0,
        matches: true,
      },
    ]);
  });

  it("links the three transfers and links each pair both ways", () => {
    const rows = parsed.transactions.transactions;
    expect(parsed.transactions.transfersLinked).toBe(3);
    const transfers = rows.filter((r) => r.isTransfer);
    expect(transfers.map((r) => r.handle)).toEqual([4, 4, 5, 5, 7, 7]);
    for (const row of transfers) {
      const other = rows.find((r) => r.id === row.linkedTransactionId);
      expect(other?.linkedTransactionId).toBe(row.id);
    }
    const eur = rows.find((r) => r.handle === 5 && r.currencyCode === "EUR");
    expect(eur).toMatchObject({ amount: 1000, exchangeRate: 0.9090909091 });
    const split = rows.find((r) => r.handle === 3);
    expect(split).toMatchObject({
      amount: -120.5,
      status: TransactionStatus.RECONCILED,
      reconciledDate: "2024-01-31",
    });
    expect(split?.splits.map((s) => s.amount)).toEqual([-100.5, -20]);
  });

  it("agrees with itself: the file's balances equal the mapped rows' for every key", () => {
    expect(parsed.fileBalances).toBeDefined();
    expect([...(parsed.fileBalances ?? [])].sort()).toEqual(
      [...parsed.expectedBalances].sort(),
    );
    expect(Object.fromEntries(parsed.expectedBalances)).toEqual({
      "acct-6": 2804.5,
      "acct-7": 1000,
      "acct-9": 647.5,
      "acct-8": 0,
      "acct-17": 0,
    });
    expect(parsed.transactionCounts.get("acct-9")).toBe(4);
    expect(parsed.investmentCounts.get("acct-8")).toBe(4);
  });

  it("gives City Power its alias and default category and Corner Market none (spec 5.5.5)", () => {
    const electricity = parsed.categories.categories.find(
      (c) => c.name === "Electricity",
    );
    expect(parsed.payees.payees).toEqual([
      { handle: 1, name: "Corner Market" },
      {
        handle: 2,
        name: "City Power",
        aliases: ["*CITY POWER*"],
        defaultCategoryHandle: electricity?.handle,
      },
    ]);
    expect(electricity).toBeDefined();
  });

  it("writes a written payee's default category, with its parent, under referenced-only categories", () => {
    const raw = rawFile({
      baseCurrency: "USD",
      payees: [rawPayee("P1", "Landlord", { defaultAccountId: "A3" })],
      accounts: [
        ...standardRoots(),
        rawAccount({ id: "A1", name: "Housing", type: 13 }),
        rawAccount({ id: "A2", name: "Unused", type: 13 }),
        rawAccount({ id: "A3", name: "Rent", type: 13, parentId: "A1" }),
      ],
    });
    const result = mapKmyFile(raw, {
      ...INPUT,
      options: { referencedOnlyPayees: false, referencedOnlyCategories: true },
    });
    expect(result.categories.categories.map((c) => c.name)).toEqual([
      "Housing",
      "Rent",
    ]);
    const rent = result.categories.categories.find((c) => c.name === "Rent");
    expect(result.payees.payees[0].defaultCategoryHandle).toBe(rent?.handle);
  });

  it("raises exactly the warnings the plan names", () => {
    expect(parsed.warnings.map((w) => [w.code, w.subject])).toEqual([
      ["accountNumbersNotImported", "Checking"],
      ["scheduleWeekendRuleDropped", "Electricity"],
      ["scheduleOverdue", "Electricity"],
      ["payeeMatchingDisabled", "Corner Market"],
      ["budgetsNotImported", undefined],
    ]);
  });

  it("counts what the file holds", () => {
    expect(parsed.fileCounts).toEqual({
      accounts: 5,
      payees: 2,
      categories: 5,
      securities: 1,
      securityPrices: 2,
      exchangeRates: 1,
      bills: 1,
      transactions: 11,
    });
    expect(parsed.loans.loans).toEqual([]);
  });

  it("maps the same raw model twice to the same result", () => {
    const again = mapKmyFile(syntheticKmyFile(), INPUT);
    expect(strip(again)).toEqual(strip(parsed));
  });
});

describe("mapKmyFile: options and the model's other inputs", () => {
  it("honours an explicit bill selection, including an empty one", () => {
    expect(
      mapKmyFile(syntheticKmyFile(), { ...INPUT, options: { bills: [] } })
        .options.bills,
    ).toEqual([]);
    expect(
      mapKmyFile(syntheticKmyFile(), { ...INPUT, options: { bills: [1, 99] } })
        .options.bills,
    ).toEqual([1]);
  });

  it("imports every category and payee unless asked to import only referenced ones", () => {
    const raw = rawFile({
      accounts: [
        rawAccount({ id: "CHK", name: "Checking", type: 1 }),
        rawAccount({ id: "USED", name: "Used", type: 13 }),
        rawAccount({ id: "UNUSED", name: "Unused", type: 13 }),
      ],
      transactions: [
        rawTransaction({
          splits: [
            { account: "CHK", value: "-1" },
            { account: "USED", value: "1" },
          ],
        }),
      ],
    });
    expect(
      mapKmyFile(raw, INPUT).categories.categories.map((c) => c.name),
    ).toEqual(["Used"]);
    expect(
      mapKmyFile(raw, {
        ...INPUT,
        options: { referencedOnlyCategories: false },
      }).categories.categories.map((c) => c.name),
    ).toEqual(["Used", "Unused"]);
  });

  it("imports a payee, account and investment pair whose names are too long for their columns (issue #2313)", () => {
    const sepa = `SEPA-LASTSCHRIFT ${"Mandatsreferenz MR-0042 ".repeat(15)}`;
    const raw = rawFile({
      payees: [rawPayee("P1", sepa)],
      accounts: [
        rawAccount({ id: "CHK", name: "c".repeat(300), type: 1 }),
        rawAccount({ id: "DUP", name: "c".repeat(300), type: 1 }),
        rawAccount({ id: "INV", name: "i".repeat(300), type: 7 }),
        rawAccount({ id: "FOOD", name: "Food", type: 13 }),
      ],
      transactions: [
        rawTransaction({
          splits: [
            { account: "CHK", value: "-10", payee: "P1" },
            { account: "FOOD", value: "10", payee: "P1" },
          ],
        }),
      ],
    });

    const cut = mapKmyFile(raw, INPUT);
    for (const account of cut.accounts.accounts) {
      expect(account.name.length).toBeLessThanOrEqual(255);
    }
    // Two names cut to the same text stay two accounts, both within the column.
    expect(cut.accounts.accounts.map((a) => a.name)).toEqual(
      expect.arrayContaining(["c".repeat(255), `${"c".repeat(251)} (2)`]),
    );
    const payee = cut.payees.payees[0];
    expect(payee.name).toBe(sepa.slice(0, 255).trimEnd());
    expect(cut.payees.nameByHandle.get(1)).toBe(payee.name);
    expect(cut.nameFixes?.entries.map((fix) => fix.kind)).toEqual([
      "payee",
      "account",
      "account",
      "account",
    ]);
    expect(cut.options.renames).toContainEqual({
      kind: "payee",
      handle: 1,
      name: payee.name,
    });

    const renamed = mapKmyFile(raw, {
      ...INPUT,
      options: {
        renames: [
          { kind: "payee", handle: 1, name: "Stadtwerke" },
          { kind: "account", handle: 8, name: "Broker" },
        ],
      },
    });
    expect(renamed.payees.payees.map((p) => p.name)).toEqual(["Stadtwerke"]);
    expect(renamed.payees.nameByHandle.get(1)).toBe("Stadtwerke");
    expect(
      renamed.accounts.accounts
        .filter((a) => a.linkedKey !== null)
        .map((a) => a.name),
    ).toEqual(["Broker - Cash", "Broker - Brokerage"]);
    // The preview's list does not depend on the renames sent.
    expect(renamed.nameFixes).toEqual(cut.nameFixes);
  });

  it("keeps a replaced name's whole text in the payee's notes and the account's description (issue #2313)", () => {
    const sepa =
      `SEPA-LASTSCHRIFT ${"Mandatsreferenz MR-0042 ".repeat(15)}`.trim();
    const raw = rawFile({
      payees: [
        rawPayee("P1", sepa, { notes: "Paid monthly" }),
        rawPayee("P2", `${sepa} ${"x".repeat(600)}`),
      ],
      accounts: [
        rawAccount({
          id: "CHK",
          name: `Girokonto ${"g".repeat(300)}`,
          type: 1,
          description: "Main",
        }),
        rawAccount({ id: "FOOD", name: "Food", type: 13 }),
      ],
      transactions: ["P1", "P2"].map((payee, index) =>
        rawTransaction({
          id: `T${index}`,
          splits: [
            { account: "CHK", value: "-10", payee },
            { account: "FOOD", value: "10", payee },
          ],
        }),
      ),
    });
    const parsed = mapKmyFile(raw, {
      ...INPUT,
      options: { renames: [{ kind: "payee", handle: 1, name: "Stadtwerke" }] },
    });

    const stadtwerke = parsed.payees.payees.find(
      (p) => p.name === "Stadtwerke",
    );
    expect(stadtwerke?.contact?.notes).toBe(`Paid monthly\n\n${sepa}`);
    // Too long for the 500 the payee form accepts: cut there, and said so.
    const second = parsed.payees.payees.find((p) => p.handle === 2);
    expect(second?.contact?.notes).toHaveLength(500);
    expect(parsed.warnings).toContainEqual({
      code: "originalNameCut",
      subject: second?.name,
    });

    const account = parsed.accounts.accounts.find((a) => a.key === "acct-6");
    expect(account?.description).toBe(`Main\n\nGirokonto ${"g".repeat(300)}`);
    // The review table's "named X in KMyMoney" names the file's own name.
    expect(account?.moneyName).toBe(`Girokonto ${"g".repeat(300)}`);
  });

  it("builds a match-on-name rule from the file's name, not the rename (issue #2313)", () => {
    const sepa =
      `SEPA-LASTSCHRIFT ${"Mandatsreferenz MR-0042 ".repeat(15)}`.trim();
    const raw = rawFile({
      payees: [
        rawPayee("P1", sepa, {
          match: { kind: "name", ignoreCase: true, keys: [] },
        }),
      ],
      accounts: [
        rawAccount({ id: "CHK", name: "Checking", type: 1 }),
        rawAccount({ id: "FOOD", name: "Food", type: 13 }),
      ],
      transactions: [
        rawTransaction({
          splits: [
            { account: "CHK", value: "-10", payee: "P1" },
            { account: "FOOD", value: "10", payee: "P1" },
          ],
        }),
      ],
    });
    const parsed = mapKmyFile(raw, {
      ...INPUT,
      options: { renames: [{ kind: "payee", handle: 1, name: "Stadtwerke" }] },
    });

    // `*<the whole SEPA text>*` is past the alias column, as it was before the
    // rename; the rename never widens it to `*Stadtwerke*`.
    expect(parsed.payees.payees[0].aliases).toBeUndefined();
    expect(parsed.warnings).toContainEqual(
      expect.objectContaining({
        code: "payeeMatchKeyNotImported",
        subject: `Stadtwerke: ${sepa}`,
        detail: "tooLong",
      }),
    );
  });

  it("falls back to the user's currency when the file names no base currency", () => {
    const parsed = mapKmyFile(
      rawFile({
        baseCurrency: null,
        accounts: [rawAccount({ id: "A", name: "A", currency: null })],
      }),
      INPUT,
    );
    expect(parsed.baseCurrency).toBe("CAD");
    expect(parsed.accounts.accounts[0].currencyCode).toBe("CAD");
  });

  it("converts reader warnings, with a row for one about a transaction, and counts the unread sections", () => {
    const raw = rawFile({
      accounts: [
        rawAccount({ id: "CHK", name: "Checking", type: 1 }),
        rawAccount({ id: "GRO", name: "G", type: 13 }),
      ],
      transactions: [
        rawTransaction({
          postDate: "2024-01-05",
          splits: [
            { account: "CHK", value: "-1", costCenter: "CC1" },
            { account: "GRO", value: "1", costCenter: "CC1" },
          ],
        }),
      ],
      counts: { budgets: 2, reports: 1, onlineJobs: 3 },
      readerWarnings: [
        {
          code: "unparsableNumber",
          subject: "SPLIT@value",
          transactionOrdinal: null,
        },
        { code: "autoCalcInPostedSplit", subject: "T1", transactionOrdinal: 1 },
        {
          code: "duplicateTransactionId",
          subject: "T9",
          transactionOrdinal: 77,
        },
      ],
    });
    const parsed = mapKmyFile(raw, INPUT);
    expect(parsed.warnings.map((w) => w.code)).toEqual([
      "unparsableNumber",
      "autoCalcInPostedSplit",
      "duplicateTransactionId",
      "costCentersNotImported",
      "costCentersNotImported",
      "budgetsNotImported",
      "budgetsNotImported",
      "reportsNotImported",
      "onlineJobsNotImported",
      "onlineJobsNotImported",
      "onlineJobsNotImported",
    ]);
    expect(parsed.warnings[0].row).toBeUndefined();
    expect(parsed.warnings[1].row).toMatchObject({
      handle: 1,
      date: "2024-01-05",
      accountKey: "acct-6",
    });
    expect(parsed.warnings[2].row).toBeUndefined();
  });

  it("feeds a loan payment through the shared loan inference", () => {
    const raw = rawFile({
      accounts: [
        rawAccount({ id: "CHK", name: "Checking", type: 1 }),
        rawAccount({
          id: "LOAN",
          name: "Mortgage",
          type: 5,
          kvp: { "ir-2024-01-01": "9/2" },
        }),
        rawAccount({ id: "INT", name: "Interest", type: 13 }),
      ],
      transactions: [
        rawTransaction({
          splits: [
            { account: "CHK", value: "-500" },
            { account: "LOAN", value: "400" },
            { account: "INT", value: "100" },
          ],
        }),
      ],
      schedules: [
        rawSchedule({
          type: 5,
          template: {
            postDate: "2024-02-01",
            splits: [
              { account: "CHK", value: "-500" },
              { account: "LOAN", value: "autoCalc" },
            ],
          },
        }),
      ],
    });
    const parsed = mapKmyFile(raw, INPUT);
    expect(parsed.loans.loans).toHaveLength(1);
    expect(parsed.loans.loans[0]).toMatchObject({
      accountKey: "acct-7",
      interestBookingMode: "SPLIT",
      sourceAccountKey: "acct-6",
      paymentAmount: 500,
      rates: [{ effectiveDate: "2024-01-01", annualRate: 4.5 }],
      originalPrincipal: null,
      amortizationMonths: null,
    });
    const codes = parsed.warnings.map((w) => w.code);
    expect(codes).toContain("loanScheduleSimplified");
    // The rate is imported (spec 5.11), so it is no longer a warning.
    expect(codes).not.toContain("loanInterestRateNotImported");
  });

  it("explains a holding the mapped replay cannot reproduce (a ratio inexact at 8 places)", () => {
    const raw = rawFile({
      accounts: [
        rawAccount({ id: "INV", name: "Broker", type: 7 }),
        rawAccount({
          id: "STK",
          name: "Stock",
          type: 15,
          parentId: "INV",
          currency: "E1",
        }),
      ],
      securities: [rawSecurity({ id: "E1", symbol: "EXC" })],
      transactions: [
        rawTransaction({
          id: "T1",
          postDate: "2024-01-01",
          splits: [
            { account: "STK", value: "0", shares: "300", action: "Add" },
          ],
        }),
        rawTransaction({
          id: "T2",
          postDate: "2024-02-01",
          splits: [
            { account: "STK", value: "0", shares: "1/3", action: "Split" },
          ],
        }),
      ],
    });
    const parsed = mapKmyFile(raw, INPUT);
    expect(parsed.holdingChecks[0]).toMatchObject({
      lotQuantity: 100,
      replayQuantity: 99.999999,
      matches: false,
    });
    expect(parsed.warnings.map((w) => w.code)).toEqual([
      "brokerageAccountNotFound",
      "stockSplitRatioRounded",
      "sharesAddedWithoutCost",
      "holdingsReplayDiffers",
    ]);
  });
});

describe("mapKmyFile: a coin account keeps its own places (M3)", () => {
  const raw = rawFile({
    accounts: [
      rawAccount({ id: "W", name: "Wallet", type: 1, currency: "BTC" }),
      rawAccount({
        id: "INC",
        name: "Mining",
        type: 12,
        currency: "BTC",
      }),
    ],
    transactions: ["1/3", "1/3", "1/3", "0.12345678"].map((value, index) =>
      rawTransaction({
        id: `T${index + 1}`,
        commodity: "BTC",
        postDate: `2024-01-0${index + 1}`,
        splits: [
          { account: "W", value },
          { account: "INC", value: `-${value}` },
        ],
      }),
    ),
  });
  const parse = (file = raw) =>
    mapKmyFile(file, {
      ...INPUT,
      coinDecimals: new Map([["BTC", 8]]),
    });

  it("maps, sums and compares at eight places, and allows exactly the per-row rounding", () => {
    const parsed = parse();
    const key = parsed.accounts.accounts[0].key;
    expect(parsed.transactions.transactions.map((r) => r.amount)).toEqual([
      0.33333333, 0.33333333, 0.33333333, 0.12345678,
    ]);
    // KMyMoney's own figure: the exact sum, rounded once.
    expect(parsed.fileBalances?.get(key)).toBe(1.12345678);
    // What the rows sum to, eight places kept (not 1.1235).
    expect(parsed.expectedBalances.get(key)).toBe(1.12345677);
    expect(parsed.balancePrecision?.get(key)).toEqual({
      places: 8,
      tolerance: 0.00000001,
    });
    expect(parsed.moneyPlaces?.get("BTC")).toBe(8);
    expect(parsed.warnings.map((w) => w.code)).not.toContain(
      "mappedBalanceDiffers",
    );
  });
});
