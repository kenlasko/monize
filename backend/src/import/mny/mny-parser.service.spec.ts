import { AccountType } from "../../accounts/entities/account.entity";
import { FrequencyType } from "../../scheduled-transactions/dto/create-scheduled-transaction.dto";
import { TransactionStatus } from "../../transactions/entities/transaction.entity";
import { InvestmentAction } from "../../securities/entities/investment-transaction.entity";
import { MNY_FIXTURES, readMnyFixture } from "./__fixtures__/mny-fixtures";
import {
  mnyAccount,
  mnyCurrency,
  mnyDefaults,
  referenceData,
} from "./__fixtures__/mny-row-builders";
import { mapAccounts } from "./map/map-reference";
import { DEFAULT_MNY_IMPORT_OPTIONS } from "./model/mny-import-options";
import { MappedBill, MappedTransactions } from "./model/mny-import-model";
import {
  MnyParserService,
  computeExpectedBalances,
  todayIsoDate,
} from "./mny-parser.service";
import { buildPreview } from "./mny-preview";

describe("todayIsoDate", () => {
  it("formats from local calendar components, not a UTC shift", () => {
    // 23:30 local on the 5th must be the 5th, whatever the offset.
    expect(todayIsoDate(new Date(2026, 6, 5, 23, 30))).toBe("2026-07-05");
    expect(todayIsoDate(new Date(2026, 0, 1, 0, 5))).toBe("2026-01-01");
  });
});

describe("computeExpectedBalances", () => {
  function accountsWith(openingBalance: number) {
    return mapAccounts(
      referenceData({
        currencies: [mnyCurrency({ handle: 1, isoCode: "USD" })],
        defaults: mnyDefaults({ defaultCurrency: 1 }),
        accounts: [mnyAccount({ handle: 1, name: "Chequing", openingBalance })],
      }),
      DEFAULT_MNY_IMPORT_OPTIONS,
      "USD",
    );
  }

  function transactionsWith(
    rows: Array<{ amount: number; date: string; status?: TransactionStatus }>,
  ): MappedTransactions {
    return {
      transactions: rows.map((row, index) => ({
        id: `id-${index}`,
        handle: index + 1,
        accountKey: "acct-1",
        transactionDate: row.date,
        amount: row.amount,
        currencyCode: "USD",
        exchangeRate: 1,
        status: row.status ?? TransactionStatus.CLEARED,
        payeeHandle: null,
        categoryHandle: null,
        description: null,
        referenceNumber: null,
        isTransfer: false,
        linkedTransactionId: null,
        splits: [],
        collapsedTradeHandle: null,
        tagHandles: [],
      })),
      referencedPayees: new Set(),
      referencedCategories: new Set(),
      referencedTags: new Set(),
      tradeCashLegTagHandles: new Map(),
      transfersLinked: 0,
      skipped: 0,
      deferredInvestments: 0,
      tradeCashLegs: 0,
      investmentCashSources: new Map(),
      warnings: [],
    };
  }

  it("adds the opening balance to every posting", () => {
    const balances = computeExpectedBalances(
      accountsWith(100),
      transactionsWith([
        { amount: -25.5, date: "2026-01-02" },
        { amount: 10.25, date: "2026-01-03" },
      ]),
      "2026-12-31",
    );

    expect(balances.get("acct-1")).toBe(84.75);
  });

  it("excludes voided transactions, as Monize's own balance query does", () => {
    const balances = computeExpectedBalances(
      accountsWith(0),
      transactionsWith([
        { amount: -50, date: "2026-01-02" },
        { amount: -999, date: "2026-01-03", status: TransactionStatus.VOID },
      ]),
      "2026-12-31",
    );

    expect(balances.get("acct-1")).toBe(-50);
  });

  it("excludes future-dated transactions so a post-dated cheque is not a discrepancy", () => {
    const balances = computeExpectedBalances(
      accountsWith(0),
      transactionsWith([
        { amount: -50, date: "2026-07-01" },
        { amount: -500, date: "2026-08-01" },
      ]),
      "2026-07-29",
    );

    expect(balances.get("acct-1")).toBe(-50);
  });

  it("includes a transaction dated exactly on the cut-off", () => {
    const balances = computeExpectedBalances(
      accountsWith(0),
      transactionsWith([{ amount: -50, date: "2026-07-29" }]),
      "2026-07-29",
    );

    expect(balances.get("acct-1")).toBe(-50);
  });

  it("does not drift over many fractional amounts", () => {
    // Float accumulation of 0.1 three thousand times is visibly wrong.
    const balances = computeExpectedBalances(
      accountsWith(0),
      transactionsWith(
        Array.from({ length: 3000 }, () => ({
          amount: 0.1,
          date: "2026-01-02",
        })),
      ),
      "2026-12-31",
    );

    expect(balances.get("acct-1")).toBe(300);
  });

  it("ignores a transaction in an account that is not being imported", () => {
    const balances = computeExpectedBalances(
      accountsWith(0),
      {
        ...transactionsWith([{ amount: -50, date: "2026-01-02" }]),
        transactions: [
          {
            ...transactionsWith([{ amount: -50, date: "2026-01-02" }])
              .transactions[0],
            accountKey: "acct-999",
          },
        ],
      },
      "2026-12-31",
    );

    expect(balances.get("acct-1")).toBe(0);
  });
});

describe("MnyParserService", () => {
  const service = new MnyParserService();

  describe("every committed fixture", () => {
    it.each(Object.keys(MNY_FIXTURES) as Array<keyof typeof MNY_FIXTURES>)(
      "parses %s end to end",
      (name) => {
        const parsed = service.parse({
          buffer: readMnyFixture(name),
          password: MNY_FIXTURES[name].password,
          userDefaultCurrency: "CAD",
        });

        expect(parsed.accounts.accounts.length).toBeGreaterThan(0);
        expect(parsed.baseCurrency).toMatch(/^[A-Z]{3}$/);
        expect(parsed.expectedBalances.size).toBe(
          parsed.accounts.accounts.length,
        );
      },
    );
  });

  describe("era detection", () => {
    it.each([
      ["money99", "money99"],
      ["money2001", "money2001"],
      ["money2002", "money2002"],
      ["money2008", "moneyPlus"],
    ] as const)("reports %s as %s", (fixture, era) => {
      const parsed = service.parse({
        buffer: readMnyFixture(fixture),
        userDefaultCurrency: "CAD",
      });

      expect(parsed.era).toBe(era);
    });
  });

  describe("money2008.mny", () => {
    const parse = () =>
      service.parse({
        buffer: readMnyFixture("money2008"),
        userDefaultCurrency: "CAD",
        asOf: "2026-07-29",
      });

    it("takes USD from the file, not the user's preference", () => {
      expect(parse().baseCurrency).toBe("USD");
    });

    it("turns its single investment account into a linked pair", () => {
      const parsed = parse();

      expect(parsed.accounts.accounts).toHaveLength(2);
      expect(
        parsed.accounts.accounts.every(
          (account) => account.accountType === AccountType.INVESTMENT,
        ),
      ).toBe(true);
      expect(parsed.accounts.accounts.map((a) => a.name)).toEqual([
        "Investments to Watch - Cash",
        "Investments to Watch - Brokerage",
      ]);
    });

    it("excludes the watch account from net worth, from the file's own fWatch", () => {
      const parsed = parse();

      expect(
        parsed.accounts.accounts.every(
          (account) => account.excludeFromNetWorth,
        ),
      ).toBe(true);
    });

    it("defers all three of its investment transactions", () => {
      const parsed = parse();

      // Every transaction in this file carries a security (act 1, SELL).
      expect(parsed.transactions.transactions).toEqual([]);
      expect(parsed.transactions.deferredInvestments).toBe(3);
      expect(parsed.transactions.skipped).toBe(0);
    });

    it("computes both sides' balances as their opening balances", () => {
      const parsed = parse();

      // Hand-computed: amtOpen is 0 on the account and there are no banking
      // postings to move it.
      for (const account of parsed.accounts.accounts) {
        expect(parsed.expectedBalances.get(account.key)).toBe(0);
      }
    });

    it("reports no missing tables and no defaulted fields", () => {
      const parsed = parse();

      expect(parsed.missingTables).toEqual([]);
      expect(parsed.missingFields).toEqual([]);
    });

    it("counts only real securities, not currency pseudo-securities", () => {
      const parsed = parse();

      expect(parsed.fileCounts.securities).toBe(3);
      // 128 CAT rows, less Money's two structural roots.
      expect(parsed.fileCounts.categories).toBe(126);
    });
  });

  describe("money2001.mny", () => {
    it("degrades gracefully over the tables it does not have", () => {
      const parsed = service.parse({
        buffer: readMnyFixture("money2001"),
        userDefaultCurrency: "CAD",
      });

      // The missing BILL table is what crash-looped the PR #192 proof of concept.
      expect(parsed.missingTables).toContain("BILL");
      expect(parsed.warnings).toEqual(
        expect.arrayContaining([{ code: "missingTable", subject: "BILL" }]),
      );
      expect(parsed.accounts.accounts.length).toBeGreaterThan(0);
    });
  });

  describe("sample-money99.mny", () => {
    // Ground truth is Money 99's own account list for this file, which counts
    // every posted row, future-dated ones included, so `asOf` is set past the
    // file's last date. See docs/future-plans/mny-money99-import.md.
    const parse = () => {
      // The staged path: `POST /parse` reads the upload, the job re-reads the
      // same bytes. Asserting on the re-read is asserting on what imports.
      const buffer = readMnyFixture("money99");
      const options = { userDefaultCurrency: "CAD", asOf: "2099-12-31" };
      service.parse({ buffer, ...options });
      return service.parse({ buffer, alreadyDecrypted: true, ...options });
    };
    const balanceOf = (
      parsed: ReturnType<typeof parse>,
      accountName: string,
    ) => {
      const account = parsed.accounts.accounts.find(
        (candidate) => candidate.name === accountName,
      );
      return account === undefined
        ? undefined
        : parsed.expectedBalances.get(account.key);
    };
    const handles = (parsed: ReturnType<typeof parse>) =>
      new Set(parsed.transactions.transactions.map((row) => row.handle));

    it("reproduces every balance Money 99 shows", () => {
      const parsed = parse();

      expect(parsed.baseCurrency).toBe("USD");
      expect(balanceOf(parsed, "Chase Bank")).toBe(2105);
      expect(balanceOf(parsed, "Chase Credit card")).toBe(-185);
      expect(balanceOf(parsed, "Chase Investmen - Cash")).toBe(22658);
      expect(balanceOf(parsed, "Chase Savings")).toBe(11010);
      expect(balanceOf(parsed, "Loan")).toBe(-4209.39);
    });

    it("replays the holdings the tax lots record", () => {
      const parsed = parse();

      expect(
        parsed.holdingChecks.map((check) => [
          check.symbol,
          check.lotQuantity,
          check.replayQuantity,
        ]),
      ).toEqual(expect.arrayContaining([["AMzn", 11, 11]]));
      expect(parsed.holdingChecks.every((check) => check.delta === 0)).toBe(
        true,
      );
      expect(parsed.warnings.map((warning) => warning.code)).not.toContain(
        "holdingsMismatch",
      );
    });

    it("imports the voided row as VOID", () => {
      const voided = parse().transactions.transactions.find(
        (row) => row.handle === 91,
      );

      expect(voided?.status).toBe(TransactionStatus.VOID);
    });

    it("imports no pending scheduled instance and no loan-template row", () => {
      const imported = handles(parse());

      for (const handle of [3, 4, 43, 44, 45, 46, 64, 67, 68, 72, 5, 6, 7, 8]) {
        expect(imported.has(handle)).toBe(false);
      }
    });

    it("imports other income and expenses as categorized cash rows, not trades", () => {
      const parsed = parse();
      const otherIncome = parsed.transactions.transactions.find(
        (row) => row.handle === 88,
      );

      expect(otherIncome).toMatchObject({
        amount: 10,
        isTransfer: false,
        linkedTransactionId: null,
      });
      expect(otherIncome?.categoryHandle).not.toBeNull();
      expect(handles(parsed).has(90)).toBe(true);
      const tradeHandles = parsed.investments.transactions.map(
        (trade) => trade.handle,
      );
      expect(tradeHandles).not.toContain(87);
      expect(tradeHandles).not.toContain(89);
    });

    it("offers each scheduled series once, from its paying leg", () => {
      const parsed = parse();

      expect(parsed.missingTables).toEqual([]);
      expect(
        parsed.bills.bills.map((bill) => [
          bill.handle,
          bill.amount,
          bill.frequency,
          bill.isTransfer,
        ]),
      ).toEqual([
        [1, -100, "MONTHLY", true],
        [61, -15, "MONTHLY", false],
        [65, -2, "MONTHLY", true],
        [69, 1500, "MONTHLY", false],
      ]);
    });

    it("reports the scheduled loan payment, which Money 99 gave no paying account", () => {
      expect(parse().bills.warnings).toEqual([
        { code: "unusableBill", subject: "hbill=39", detail: "no account" },
      ]);
    });

    it("skips the stock option events with one named warning each", () => {
      const codes = parse().warnings.map((warning) => warning.code);

      expect(
        codes.filter((code) => code === "stockOptionNotImported"),
      ).toHaveLength(9);
      expect(codes).not.toContain("unknownInvestmentAction");
      expect(codes).not.toContain("unconfirmedInvestmentAction");
    });
  });

  describe("sample-money99-investments.mny", () => {
    // The same author's later copy of sample-money99.mny, rebuilt to reproduce
    // what their real file raised. Expected balances are the sums of Money's own
    // register rows per account (the loan's carries the file's EUR->USD typo).
    const parse = () => {
      const buffer = readMnyFixture("money99Investments");
      const options = { userDefaultCurrency: "CAD", asOf: "2099-12-31" };
      service.parse({ buffer, ...options });
      return service.parse({ buffer, alreadyDecrypted: true, ...options });
    };
    const keyOf = (parsed: ReturnType<typeof parse>, accountName: string) =>
      parsed.accounts.accounts.find((account) => account.name === accountName)
        ?.key;
    const codes = (parsed: ReturnType<typeof parse>) =>
      parsed.warnings.map((warning) => warning.code);

    it("keeps every cash row Money shows, interest included", () => {
      const parsed = parse();
      const balance = (name: string) =>
        parsed.expectedBalances.get(keyOf(parsed, name) as string);

      expect(balance("Chase Bank")).toBe(2014.03);
      expect(balance("Chase Investmen - Cash")).toBe(22468);
      expect(balance("Chase Credit card")).toBe(-185);
      expect(balance("Chase Savings")).toBe(11010);
      expect(balance("Loan")).toBe(5026);
    });

    it("imports act 2 as interest on the bond and the CD", () => {
      const interest = parse().investments.transactions.filter(
        (trade) => trade.action === InvestmentAction.INTEREST,
      );

      expect(interest.map((trade) => [trade.handle, trade.cashAmount])).toEqual(
        [
          [107, 10],
          [111, 1],
        ],
      );
    });

    it("holds the CD by amount and the split shares as Money recorded them", () => {
      const parsed = parse();

      expect(
        parsed.holdingChecks.map((check) => [
          check.symbol,
          check.lotQuantity,
          check.replayQuantity,
        ]),
      ).toEqual(
        expect.arrayContaining([
          ["AMzn", 22, 22],
          [expect.stringMatching(/^CT/), 99, 99],
          [expect.stringMatching(/^GB/), 10, 10],
        ]),
      );
      expect(codes(parsed)).not.toContain("holdingsMismatch");
      expect(codes(parsed)).not.toContain("securitySplitNotApplied");
      expect(codes(parsed)).not.toContain("missingInvestmentDetail");
      expect(codes(parsed)).not.toContain("unknownInvestmentAction");
    });

    it("names no column Money 99 never had", () => {
      const parsed = parse();

      expect(parsed.missingFields).toEqual(
        expect.arrayContaining(["ACCT.watch", "TRN_INV.interest"]),
      );
      expect(codes(parsed)).not.toContain("missingField");
    });
  });

  describe("password handling", () => {
    it("opens a protected file with the right password", () => {
      const parsed = service.parse({
        buffer: readMnyFixture("money2008Pwd"),
        password: MNY_FIXTURES.money2008Pwd.password,
        userDefaultCurrency: "CAD",
      });

      expect(parsed.passwordProtected).toBe(true);
    });

    it("reports a protected file as needing a password", () => {
      expect(() =>
        service.parse({
          buffer: readMnyFixture("money2008Pwd"),
          userDefaultCurrency: "CAD",
        }),
      ).toThrow(expect.objectContaining({ code: "mnyPasswordRequired" }));
    });

    it("re-parses staged bytes without asking for the password again", () => {
      // Staging stores the decrypted file so the password is spent once
      // (ADR-2, ADR-7). The import job re-parses those bytes, and must neither
      // demand a password nor decrypt a second time -- the second pass would
      // re-encrypt the file, which is how every real import failed until the
      // wizard's own e2e ran it.
      const buffer = readMnyFixture("money2008Pwd");
      const first = service.parse({
        buffer,
        password: MNY_FIXTURES.money2008Pwd.password,
        userDefaultCurrency: "CAD",
      });

      const reparsed = service.parse({
        buffer,
        alreadyDecrypted: true,
        userDefaultCurrency: "CAD",
      });

      expect(reparsed.passwordProtected).toBe(true);
      expect(reparsed.accounts.accounts).toHaveLength(
        first.accounts.accounts.length,
      );
      expect(reparsed.expectedBalances).toEqual(first.expectedBalances);
    });

    it("tells a wrong password apart from a missing one", () => {
      expect(() =>
        service.parse({
          buffer: readMnyFixture("money2008Pwd"),
          password: "not-the-password",
          userDefaultCurrency: "CAD",
        }),
      ).toThrow(expect.objectContaining({ code: "mnyPasswordIncorrect" }));
    });

    it("opens an unprotected file that still carries crypt-check bytes", () => {
      const parsed = service.parse({
        buffer: readMnyFixture("money2008"),
        userDefaultCurrency: "CAD",
      });

      expect(parsed.passwordProtected).toBe(false);
    });
  });

  describe("options", () => {
    it("echoes the resolved options, filling server-side defaults", () => {
      const parsed = service.parse({
        buffer: readMnyFixture("money2008"),
        options: { wipeExistingData: true },
        userDefaultCurrency: "CAD",
      });

      expect(parsed.options.wipeExistingData).toBe(true);
      expect(parsed.options.referencedOnlyPayees).toBe(true);
    });

    it("honours an account exclusion, dropping the pair it belongs to", () => {
      const parsed = service.parse({
        buffer: readMnyFixture("money2008"),
        options: {
          accounts: [{ handle: 1, include: false, currencyOverride: null }],
        },
        userDefaultCurrency: "CAD",
      });

      expect(parsed.accounts.accounts).toEqual([]);
    });
  });
});

describe("buildPreview", () => {
  const service = new MnyParserService();

  function preview() {
    return buildPreview({
      parsed: service.parse({
        buffer: readMnyFixture("money2002"),
        userDefaultCurrency: "CAD",
        asOf: "2026-07-29",
      }),
      stagedFileId: "staged-1",
      filename: "money2002.mny",
      sizeBytes: 123456,
    });
  }

  it("carries the staged file identity the import call needs", () => {
    expect(preview()).toMatchObject({
      stagedFileId: "staged-1",
      filename: "money2002.mny",
      sizeBytes: 123456,
    });
  });

  it("reports the file's own base currency and era", () => {
    expect(preview()).toMatchObject({ baseCurrency: "GBP", era: "money2002" });
  });

  it("carries each account's net-worth exclusion so the wizard can badge it", () => {
    // money2002 holds the watch account ("Investments to Watch", fWatch true)
    // and a real investment pair; only the watch pair is excluded.
    const byName = new Map(
      preview().accounts.map((row) => [row.name, row.excludeFromNetWorth]),
    );

    expect(byName.get("Investments to Watch - Cash")).toBe(true);
    expect(byName.get("Investments to Watch - Brokerage")).toBe(true);
    expect(byName.get("None Investment - Cash")).toBe(false);
    expect(byName.get("None Investment - Brokerage")).toBe(false);
  });

  it("gives every account a review row with both balances", () => {
    const rows = preview().accounts;

    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(typeof row.openingBalance).toBe("number");
      expect(typeof row.finalBalance).toBe("number");
      expect(row.currencyCode).toMatch(/^[A-Z]{3}$/);
    }
  });

  it("shows referenced-versus-total counts for payees and categories", () => {
    const counts = preview().counts;

    expect(counts.categoriesInFile).toBeGreaterThan(counts.categoriesToCreate);
    expect(counts.accountsIncluded).toBeGreaterThan(0);
  });

  it("reports no tags for a file without classifications", () => {
    // No committed fixture defines a classification; the shape is pinned by
    // map-classifications.spec.ts over plain rows.
    const counts = preview().counts;

    expect(counts.tagsInFile).toBe(0);
    expect(counts.tagsToCreate).toBe(0);
  });

  it("surfaces the file's defaulted fields as a notice", () => {
    // money2002 has no CRNC.fHidden column.
    expect(preview().missingFields).toContain("CRNC.hidden");
  });

  it("carries no row data, only summaries", () => {
    const payload = JSON.stringify(preview());

    // 60 transactions and 86 securities must not appear in the payload.
    expect(payload).not.toContain("htrn");
    expect(payload.length).toBeLessThan(20000);
  });

  it("groups warnings by code rather than listing every occurrence", () => {
    for (const warning of preview().warnings) {
      expect(typeof warning.count).toBe("number");
      expect(warning.samples.length).toBeLessThanOrEqual(5);
    }
  });

  describe("bills", () => {
    /**
     * No committed fixture has a single `BILL` row (open question 12.3), so
     * the review step's bill list is driven from a mapped bill grafted onto a
     * real parse -- the same split the design's test strategy uses everywhere
     * the corpus falls short.
     */
    function bill(overrides: Partial<MappedBill> = {}): MappedBill {
      return {
        handle: 7,
        seriesKey: 7,
        status: 3,
        name: "Hydro One",
        // The first account of the money2002 parse, resolved below.
        accountKey: "",
        payeeHandle: null,
        categoryHandle: null,
        amount: -95.5,
        currencyCode: "GBP",
        frequency: FrequencyType.MONTHLY,
        approximate: false,
        nextDueDate: "2026-08-02",
        endDate: null,
        description: null,
        isTransfer: false,
        transferAccountKey: null,
        investment: null,
        splits: [],
        tagHandles: [],
        ...overrides,
      };
    }

    function previewWithBills(bills: MappedBill[]) {
      const parsed = service.parse({
        buffer: readMnyFixture("money2002"),
        userDefaultCurrency: "CAD",
        asOf: "2026-07-29",
      });
      const accountKey = parsed.accounts.accounts[0].key;

      return buildPreview({
        parsed: {
          ...parsed,
          bills: {
            bills: bills.map((entry) => ({ ...entry, accountKey })),
            seriesInFile: 4,
            skipped: 2,
            supported: true,
            warnings: [],
          },
        },
        stagedFileId: "staged-1",
        filename: "money2002.mny",
        sizeBytes: 123456,
      });
    }

    it("lists each candidate with the account name the user will recognize", () => {
      const preview = previewWithBills([bill()]);

      expect(preview.bills).toHaveLength(1);
      expect(preview.bills[0]).toMatchObject({
        handle: 7,
        name: "Hydro One",
        amount: -95.5,
        frequency: FrequencyType.MONTHLY,
        nextDueDate: "2026-08-02",
        isTransfer: false,
        isInvestment: false,
        splitCount: 0,
        // Carried untouched so a real file can pin what `st` means.
        status: 3,
      });
      expect(preview.bills[0].accountName).toBe(preview.accounts[0].name);
    });

    it("counts candidates against the file's raw bill rows", () => {
      const preview = previewWithBills([bill(), bill({ handle: 8 })]);

      expect(preview.counts.billsDetected).toBe(2);
      expect(preview.counts.billsSkipped).toBe(2);
    });

    it("flags a transfer, investment or split bill for the checkbox list", () => {
      const preview = previewWithBills([
        bill({
          handle: 9,
          isTransfer: true,
          transferAccountKey: "acct-2",
          approximate: true,
          investment: {
            action: "BUY" as never,
            securityHandle: 1,
            quantity: 1,
            price: 1,
            commission: 0,
          },
          splits: [
            {
              kind: "CATEGORY" as never,
              categoryHandle: 61,
              transferAccountKey: null,
              amount: -50,
              memo: null,
            },
          ],
        }),
      ]);

      expect(preview.bills[0]).toMatchObject({
        isTransfer: true,
        isInvestment: true,
        approximate: true,
        splitCount: 1,
      });
    });

    it("has an empty bill list for a file with no BILL table", () => {
      // money2002 itself: the table exists but holds no rows.
      expect(preview().bills).toEqual([]);
      expect(preview().counts.billsDetected).toBe(0);
    });
  });
});
