import {
  AccountSubType,
  AccountType,
} from "../../../accounts/entities/account.entity";
import {
  rawAccount,
  rawFile,
  rawInstitution,
} from "../__fixtures__/kmy-raw-builders";
import { harness } from "./kmy-map.harness";
import { withOpeningBalances } from "./kmy-map-accounts";

function mapped(
  accounts: ReturnType<typeof rawAccount>[],
  init: Parameters<typeof harness>[1] = {},
  extra: Parameters<typeof rawFile>[0] = {},
) {
  return harness(rawFile({ ...extra, accounts }), init).drafted;
}

describe("mapKmyAccounts: the type table (spec 5.2.1)", () => {
  it.each([
    [1, AccountType.CHEQUING],
    [2, AccountType.SAVINGS],
    [3, AccountType.CASH],
    [4, AccountType.CREDIT_CARD],
    [5, AccountType.LOAN],
    [6, AccountType.SAVINGS],
    [8, AccountType.SAVINGS],
    [9, AccountType.ASSET],
    [10, AccountType.LOAN],
    [11, AccountType.ASSET],
    [14, AccountType.ASSET],
  ])("maps type %i to %s", (type, expected) => {
    const result = mapped([rawAccount({ id: "A", type })]);
    expect(result.mapped.accounts).toHaveLength(1);
    expect(result.mapped.accounts[0].accountType).toBe(expected);
    expect(result.mapped.accounts[0].key).toBe("acct-6");
  });

  it("does not import categories, equity, stock accounts or the standard roots", () => {
    const result = mapped([
      rawAccount({ id: "C", type: 13 }),
      rawAccount({ id: "I", type: 12 }),
      rawAccount({ id: "E", type: 16 }),
      rawAccount({ id: "S", type: 15, parentId: "A" }),
      rawAccount({ id: "A", type: 1 }),
    ]);
    expect(result.mapped.accounts.map((a) => a.moneyName)).toEqual(["A"]);
    expect(result.mapped.warnings).toEqual([]);
    expect(result.mapped.skipped).toBe(0);
  });

  it("skips type 0, an unknown type and an unreachable account, each warned", () => {
    const result = mapped([
      rawAccount({ id: "U", name: "Mystery", type: 0 }),
      rawAccount({ id: "V", name: "Odd", type: 17 }),
      rawAccount({ id: "L1", name: "Loop1", type: 1, parentId: "L2" }),
      rawAccount({ id: "L2", name: "Loop2", type: 1, parentId: "L1" }),
    ]);
    expect(result.mapped.accounts).toHaveLength(0);
    expect(result.mapped.skipped).toBe(4);
    expect(result.mapped.warnings).toEqual([
      { code: "unknownAccountType", subject: "Mystery", detail: "type=0" },
      { code: "unknownAccountType", subject: "Odd", detail: "type=17" },
      { code: "unknownAccountType", subject: "Loop1", detail: "unreachable" },
      { code: "unknownAccountType", subject: "Loop2", detail: "unreachable" },
    ]);
  });
});

describe("mapKmyAccounts: fields (spec 5.2.1)", () => {
  it("de-duplicates names case-insensitively and names an empty one Account", () => {
    const result = mapped([
      rawAccount({ id: "A", name: "Savings" }),
      rawAccount({ id: "B", name: " savings " }),
      rawAccount({ id: "C", name: "Savings" }),
      rawAccount({ id: "D", name: "  " }),
    ]);
    expect(result.mapped.accounts.map((a) => a.name)).toEqual([
      "Savings",
      "savings (2)",
      "Savings (3)",
      "Account",
    ]);
    expect(result.mapped.accounts[1].moneyName).toBe(" savings ");
    expect(
      result.mapped.warnings.filter((w) => w.code === "duplicateAccountName"),
    ).toEqual([
      {
        code: "duplicateAccountName",
        subject: "savings",
        detail: "savings (2)",
      },
      {
        code: "duplicateAccountName",
        subject: "Savings",
        detail: "Savings (3)",
      },
    ]);
  });

  it("reads closed, favourite, description, institution and the credit limit", () => {
    const result = mapped(
      [
        rawAccount({
          id: "A",
          name: "Card",
          type: 4,
          institutionId: "I1",
          description: "notes",
          kvp: {
            "mm-closed": "Yes",
            "mm-closed-date": "2024-02-02",
            PreferredAccount: "yes",
            maxCreditAbsolute: "-5000/1",
          },
        }),
        rawAccount({
          id: "B",
          name: "Plain",
          type: 4,
          kvp: { maxCreditAbsolute: "junk" },
        }),
        rawAccount({
          id: "C",
          name: "Zero",
          type: 4,
          kvp: { maxCreditAbsolute: "0" },
        }),
        rawAccount({ id: "D", name: "NoLimit", type: 4 }),
        rawAccount({
          id: "E",
          name: "Checking",
          type: 1,
          kvp: { maxCreditAbsolute: "100" },
        }),
      ],
      {},
      { institutions: [rawInstitution("I1", "Example Bank")] },
    );
    const [card, plain, zero, noLimit, checking] = result.mapped.accounts;
    expect(card).toMatchObject({
      closed: true,
      closedDate: "2024-02-02",
      favourite: true,
      description: "notes",
      institutionName: "Example Bank",
      creditLimit: 5000,
      excludeFromNetWorth: false,
      linkedKey: null,
    });
    expect(plain).toMatchObject({
      closed: false,
      closedDate: null,
      description: null,
      institutionName: null,
      creditLimit: null,
    });
    expect(zero.creditLimit).toBeNull();
    expect(noLimit.creditLimit).toBeNull();
    expect(checking.creditLimit).toBeNull();
  });

  it("falls back to the base currency and warns for a currency the file does not define", () => {
    const result = mapped(
      [
        rawAccount({ id: "A", name: "NoCur", currency: null }),
        rawAccount({ id: "B", name: "Gone", currency: "XYZ" }),
        rawAccount({ id: "C", name: "Coin", currency: "BTC" }),
      ],
      { coinDecimals: new Map([["BTC", 8]]) },
    );
    expect(result.mapped.accounts.map((a) => a.currencyCode)).toEqual([
      "USD",
      "XYZ",
      "BTC",
    ]);
    expect(result.mapped.accounts[2].accountType).toBe(AccountType.CRYPTO);
    expect(result.mapped.warnings).toEqual([
      { code: "unknownCurrency", subject: "Gone", detail: "XYZ" },
    ]);
    expect(result.mapped.currencyCodes).toEqual(["USD", "XYZ", "BTC"]);
  });

  it("refuses a currency id that is not three letters", () => {
    const result = mapped([
      rawAccount({ id: "A", name: "Weird", currency: "E000001" }),
    ]);
    expect(result.mapped.accounts).toHaveLength(0);
    expect(result.mapped.warnings).toEqual([
      { code: "unsupportedCurrencyCode", subject: "Weird", detail: "E000001" },
    ]);
  });

  it("raises the per-account warnings of spec 5.2.1 and 5.11", () => {
    const result = mapped([
      rawAccount({ id: "P", name: "Parent", type: 1 }),
      rawAccount({
        id: "K",
        name: "Child",
        type: 2,
        parentId: "P",
        number: "123",
        hasOnlineBanking: true,
      }),
      rawAccount({
        id: "L",
        name: "Lent",
        type: 14,
        kvp: { "ir-2023-01-01": "3/1", "ir-2024-01-01": "9/2" },
      }),
      rawAccount({ id: "T", name: "Trading", type: 11, kvp: { iban: "X" } }),
      rawAccount({
        id: "M",
        name: "Mortgage",
        type: 5,
        kvp: {
          "ir-2023-01-01": "3/1",
          "ir-2024-01-01": "9/2",
          "ir-bad": "1",
        },
      }),
      rawAccount({
        id: "N",
        name: "Loan2",
        type: 5,
        kvp: { "ir-2024-01-01": "x" },
      }),
    ]);
    expect(
      result.mapped.warnings.map((w) => [w.code, w.subject, w.detail]),
    ).toEqual([
      ["accountHierarchyFlattened", "Child", undefined],
      ["accountNumbersNotImported", "Child", undefined],
      ["onlineBankingNotImported", "Child", undefined],
      ["assetLoanAsAsset", "Lent", undefined],
      // An asset loan has no rate timeline; a loan's rates import (5.11).
      ["loanInterestRateNotImported", "Lent", "4.5000"],
      ["currencyTradingAccount", "Trading", undefined],
      ["accountNumbersNotImported", "Trading", undefined],
    ]);
  });

  it("applies the wizard's selection and currency override by the account handle", () => {
    const accounts = [
      rawAccount({ id: "A", name: "Keep" }),
      rawAccount({ id: "B", name: "Drop" }),
      rawAccount({ id: "C", name: "Recurrency" }),
      rawAccount({ id: "D", name: "ClosedOne", kvp: { "mm-closed": "yes" } }),
    ];
    const result = mapped(accounts, {
      options: {
        accounts: [
          { handle: 7, include: false, currencyOverride: null },
          { handle: 8, include: true, currencyOverride: "eur" },
        ],
        importClosedAccounts: false,
      },
    });
    expect(result.mapped.accounts.map((a) => [a.name, a.currencyCode])).toEqual(
      [
        ["Keep", "USD"],
        ["Recurrency", "EUR"],
      ],
    );
    expect(result.mapped.skipped).toBe(2);
    expect(result.keyById.has("B")).toBe(false);
  });

  it("indexes keys, handles and currencies", () => {
    const result = mapped([
      rawAccount({ id: "A", name: "A", currency: "EUR" }),
    ]);
    expect(result.keyById.get("A")).toBe("acct-6");
    expect(result.mapped.keyByHandle.get(6)).toBe("acct-6");
    expect(result.mapped.currencyByHandle.get(6)).toBe("EUR");
    expect(result.currencyByKey.get("acct-6")).toBe("EUR");
  });

  it("folds opening balances in by key and leaves the others alone", () => {
    const result = mapped([
      rawAccount({ id: "A", name: "A" }),
      rawAccount({ id: "B", name: "B" }),
    ]);
    const folded = withOpeningBalances(
      result.mapped,
      new Map([["acct-6", 12.5]]),
    );
    expect(folded.accounts.map((a) => a.openingBalance)).toEqual([12.5, 0]);
  });
});

describe("mapKmyAccounts: the investment pair (spec 5.2.2)", () => {
  const investment = (extra: Partial<Parameters<typeof rawAccount>[0]> = {}) =>
    rawAccount({ id: "I", name: "Broker", type: 7, ...extra });

  it("pairs by the KVP, by the English suffix and by a translated one", () => {
    const byKvp = mapped([
      investment({ kvp: { "kmm-brokerage-account": "X" } }),
      rawAccount({ id: "X", name: "Whatever", type: 2 }),
    ]);
    expect(byKvp.pairs.get("I")).toMatchObject({
      cashKey: "acct-7",
      brokerageKey: "acct-6",
      cashAccountId: "X",
    });
    const german = mapped([
      investment(),
      rawAccount({ id: "X", name: "Broker (Verrechnung)", type: 1 }),
    ]);
    expect(german.pairs.get("I")?.cashAccountId).toBe("X");
    expect(german.mapped.accounts).toHaveLength(2);
    expect(german.mapped.accounts[0]).toMatchObject({
      key: "acct-7",
      handle: 7,
      name: "Broker - Cash",
      moneyName: "Broker (Verrechnung)",
      accountSubType: AccountSubType.INVESTMENT_CASH,
      accountType: AccountType.INVESTMENT,
      linkedKey: "acct-6",
      openingBalance: 0,
    });
    expect(german.mapped.accounts[1]).toMatchObject({
      key: "acct-6",
      handle: 6,
      name: "Broker - Brokerage",
      accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      linkedKey: "acct-7",
    });
    // The type-7 account, its cash account and the pair's cash key share a key.
    expect(german.keyById.get("I")).toBe("acct-7");
    expect(german.keyById.get("X")).toBe("acct-7");
    expect(german.mapped.keyByHandle.get(6)).toBe("acct-6");
    expect(german.mapped.warnings).toEqual([]);
  });

  it("synthesizes an empty cash side and warns when no cash account exists", () => {
    const result = mapped([investment()]);
    expect(result.pairs.get("I")).toMatchObject({
      cashKey: "acct-6-cash",
      cashAccountId: null,
    });
    expect(result.mapped.accounts[0]).toMatchObject({
      key: "acct-6-cash",
      handle: null,
    });
    expect(result.mapped.warnings).toEqual([
      { code: "brokerageAccountNotFound", subject: "Broker" },
    ]);
  });

  it("keeps a name-matched account in another currency as a standalone one", () => {
    const result = mapped([
      investment(),
      rawAccount({
        id: "X",
        name: "Broker (Brokerage)",
        type: 1,
        currency: "EUR",
      }),
    ]);
    expect(result.mapped.warnings).toEqual([
      {
        code: "brokerageCurrencyMismatch",
        subject: "Broker",
        detail: "Broker (Brokerage)",
      },
    ]);
    expect(result.mapped.accounts.map((a) => a.name)).toEqual([
      "Broker - Cash",
      "Broker - Brokerage",
      "Broker (Brokerage)",
    ]);
    expect(result.keyById.get("X")).toBe("acct-7");
  });

  it("gives a cash account claimed by two investment accounts to the first", () => {
    const result = mapped([
      investment(),
      rawAccount({ id: "J", name: "Broker", type: 7 }),
      rawAccount({ id: "X", name: "Broker (Brokerage)", type: 1 }),
    ]);
    expect(result.pairs.get("I")?.cashAccountId).toBe("X");
    expect(result.pairs.get("J")?.cashAccountId).toBeNull();
    expect(result.mapped.accounts.map((a) => a.name)).toEqual([
      "Broker - Cash",
      "Broker - Brokerage",
      "Broker - Cash (2)",
      "Broker - Brokerage (2)",
    ]);
  });

  it("is selected by the investment account's handle, taking its cash account along", () => {
    const accounts = [
      investment(),
      rawAccount({ id: "X", name: "Broker (Brokerage)", type: 1 }),
    ];
    const excluded = mapped(accounts, {
      options: {
        accounts: [{ handle: 6, include: false, currencyOverride: null }],
      },
    });
    expect(excluded.mapped.accounts).toHaveLength(0);
    expect(excluded.keyById.size).toBe(0);
    const recurrenced = mapped(accounts, {
      options: {
        accounts: [{ handle: 6, include: true, currencyOverride: "CAD" }],
      },
    });
    expect(recurrenced.mapped.accounts.map((a) => a.currencyCode)).toEqual([
      "CAD",
      "CAD",
    ]);
    // A choice sent for the cash account's own handle is ignored.
    const ignored = mapped(accounts, {
      options: {
        accounts: [{ handle: 7, include: false, currencyOverride: null }],
      },
    });
    expect(ignored.mapped.accounts).toHaveLength(2);
  });

  it("is closed only when both halves are, favourite when either is, with the institution of either", () => {
    // m10: the cash half alone closed leaves the pair open, so a brokerage
    // that still holds shares is not hidden.
    const cashOnly = mapped([
      investment(),
      rawAccount({
        id: "X",
        name: "Broker (Brokerage)",
        type: 1,
        kvp: { "mm-closed": "yes" },
      }),
    ]);
    expect(cashOnly.mapped.accounts.map((a) => a.closed)).toEqual([
      false,
      false,
    ]);
    const result = mapped(
      [
        investment({ kvp: { "mm-closed": "yes" } }),
        rawAccount({
          id: "X",
          name: "Broker (Brokerage)",
          type: 1,
          institutionId: "I1",
          kvp: {
            "mm-closed": "yes",
            "mm-closed-date": "2024-03-03",
            PreferredAccount: "yes",
          },
        }),
      ],
      {},
      { institutions: [rawInstitution("I1", "Example Bank")] },
    );
    for (const account of result.mapped.accounts) {
      expect(account).toMatchObject({
        closed: true,
        closedDate: "2024-03-03",
        favourite: true,
        institutionName: "Example Bank",
      });
    }
  });

  it("maps an investment account in a crypto currency as a plain CRYPTO account", () => {
    const result = mapped([investment({ currency: "BTC" })], {
      coinDecimals: new Map([["BTC", 8]]),
    });
    expect(result.mapped.accounts).toHaveLength(1);
    expect(result.mapped.accounts[0].accountType).toBe(AccountType.CRYPTO);
    expect(result.pairs.size).toBe(0);
  });
});
