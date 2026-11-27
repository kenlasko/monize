import { EntityManager, FindOperator } from "typeorm";
import {
  Account,
  AccountSubType,
} from "../../accounts/entities/account.entity";
import { Category } from "../../categories/entities/category.entity";
import { Currency } from "../../currencies/entities/currency.entity";
import { Payee } from "../../payees/entities/payee.entity";
import { PayeeAlias } from "../../payees/entities/payee-alias.entity";
import { UserPreference } from "../../users/entities/user-preference.entity";
import { createScopedDbMocks } from "../../test-helpers/scoped-db-testing";
import { Transaction, TransactionStatus } from "../entities/transaction.entity";
import {
  PAYEE_HISTORY_ROWS,
  USAGE_MAX_IDS,
  loadMostRecentAccountId,
  loadOwnedPayee,
  loadPayeeHistory,
  loadQuickAddCandidates,
  loadUsage,
} from "./quick-add-candidates";

const USER = "user-1";

function setup() {
  const accounts = { find: jest.fn() };
  const payees = { find: jest.fn(), findOne: jest.fn() };
  const aliases = { find: jest.fn() };
  const categories = { find: jest.fn() };
  const preferences = { findOne: jest.fn() };
  const currencies = { find: jest.fn() };
  const builder = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    getRawMany: jest.fn(),
  };
  const transactions = {
    find: jest.fn(),
    findOne: jest.fn(),
    createQueryBuilder: jest.fn(() => builder),
  };
  const { manager } = createScopedDbMocks([
    [Account, accounts],
    [Payee, payees],
    [PayeeAlias, aliases],
    [Category, categories],
    [UserPreference, preferences],
    [Currency, currencies],
    [Transaction, transactions],
  ]);
  return {
    m: manager as unknown as EntityManager,
    accounts,
    payees,
    aliases,
    categories,
    preferences,
    currencies,
    transactions,
    builder,
  };
}

describe("loadQuickAddCandidates", () => {
  it("offers the reader's open accounts but brokerages and settlement accounts, active payees and every category", async () => {
    const s = setup();
    s.accounts.find.mockResolvedValue([
      {
        id: "a1",
        name: "Chequing",
        currencyCode: "cad",
        currentBalance: 12.5,
        accountSubType: null,
      },
      {
        id: "a2",
        name: "Brokerage",
        currencyCode: "CAD",
        currentBalance: 0,
        accountSubType: AccountSubType.INVESTMENT_BROKERAGE,
      },
      {
        id: "a3",
        name: "Cash",
        currencyCode: "JPY",
        currentBalance: 0,
        accountSubType: AccountSubType.INVESTMENT_CASH,
        managedPurpose: null,
      },
      {
        id: "a4",
        name: "Trip settlement",
        currencyCode: "CAD",
        currentBalance: 0,
        accountSubType: null,
        managedPurpose: "SHARED_SETTLEMENT",
      },
    ]);
    s.payees.find.mockResolvedValue([
      { id: "p1", name: "Starbucks", defaultCategoryId: "c2" },
    ]);
    s.aliases.find.mockResolvedValue([
      { payeeId: "p1", alias: "SBUX*" },
      { payeeId: "p1", alias: "STARBUCKS #*" },
      { payeeId: "p-inactive", alias: "OLD*" },
    ]);
    s.categories.find.mockResolvedValue([
      { id: "c1", name: "Food", parentId: null, categoryType: "expense" },
      { id: "c2", name: "Coffee", parentId: "c1", categoryType: "expense" },
      { id: "c3", name: "Salary", parentId: null, categoryType: "income" },
    ]);
    s.preferences.findOne.mockResolvedValue({
      numberFormat: "de-DE",
      dateFormat: "DD.MM.YYYY",
    });
    s.currencies.find.mockResolvedValue([
      { code: "CAD", symbol: "$", decimalPlaces: 2 },
      { code: "JPY", symbol: "¥", decimalPlaces: "0" },
    ]);

    const loaded = await loadQuickAddCandidates(s.m, USER);

    expect(s.accounts.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER, isClosed: false } }),
    );
    expect(s.payees.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER, isActive: true } }),
    );
    expect(s.aliases.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER } }),
    );
    expect(s.categories.find).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER } }),
    );
    expect(loaded.accounts).toEqual([
      { id: "a1", name: "Chequing", currencyCode: "cad", currentBalance: 12.5 },
      { id: "a3", name: "Cash", currencyCode: "JPY", currentBalance: 0 },
    ]);
    expect(loaded.payees).toEqual([
      {
        id: "p1",
        name: "Starbucks",
        defaultCategoryId: "c2",
        aliases: ["SBUX*", "STARBUCKS #*"],
      },
    ]);
    expect(loaded.categories).toEqual([
      { id: "c1", name: "Food", path: "Food", categoryType: "expense" },
      {
        id: "c2",
        name: "Coffee",
        path: "Food: Coffee",
        categoryType: "expense",
      },
      { id: "c3", name: "Salary", path: "Salary", categoryType: "income" },
    ]);
    expect(loaded.numberFormat).toBe("de-DE");
    expect(loaded.dateFormat).toBe("DD.MM.YYYY");
    expect(loaded.currencies).toEqual([
      { code: "CAD", symbol: "$" },
      { code: "JPY", symbol: "¥" },
    ]);
    expect([...loaded.currencyPlaces.entries()]).toEqual([
      ["CAD", 2],
      ["JPY", 0],
    ]);
  });

  it("groups a payee's aliases in one pass, however many it has", async () => {
    const s = setup();
    s.accounts.find.mockResolvedValue([]);
    s.categories.find.mockResolvedValue([]);
    s.payees.find.mockResolvedValue([
      { id: "p1", name: "Starbucks", defaultCategoryId: null },
      { id: "p2", name: "Loblaws", defaultCategoryId: null },
    ]);
    const many = Array.from({ length: 5_000 }, (_v, i) => `SBUX ${i}*`);
    s.aliases.find.mockResolvedValue([
      ...many.map((alias) => ({ payeeId: "p1", alias })),
      { payeeId: "p2", alias: "LOBLAWS*" },
    ]);
    s.preferences.findOne.mockResolvedValue(null);
    // One map entry per payee, each alias appended to it in place: setting
    // the payee's entry again for every alias (a copy of its list each time)
    // costs the square of the alias count inside the scoped read.
    const sets = jest.spyOn(Map.prototype, "set");
    let loaded: Awaited<ReturnType<typeof loadQuickAddCandidates>>;
    let setCalls: number;
    try {
      loaded = await loadQuickAddCandidates(s.m, USER);
    } finally {
      setCalls = sets.mock.calls.length;
      sets.mockRestore();
    }
    expect(setCalls).toBeLessThan(10);
    expect(loaded.payees.map((p) => [p.id, p.aliases.length])).toEqual([
      ["p1", 5_000],
      ["p2", 1],
    ]);
    expect(loaded.payees[0].aliases).toEqual(many);
  });

  it("falls back to the default formats and reads no currency without accounts", async () => {
    const s = setup();
    for (const repo of [s.accounts, s.payees, s.aliases, s.categories]) {
      repo.find.mockResolvedValue([]);
    }
    s.preferences.findOne.mockResolvedValue(null);

    const loaded = await loadQuickAddCandidates(s.m, USER);

    expect(loaded.numberFormat).toBe("en-US");
    expect(loaded.dateFormat).toBe("YYYY-MM-DD");
    expect(loaded.currencies).toEqual([]);
    expect(s.currencies.find).not.toHaveBeenCalled();
  });
});

describe("loadOwnedPayee", () => {
  it("reads the payee as the caller's, active or not", async () => {
    const s = setup();
    s.payees.findOne.mockResolvedValue({
      id: "p9",
      name: "Old Shop",
      defaultCategoryId: null,
    });
    await expect(loadOwnedPayee(s.m, USER, "p9")).resolves.toEqual({
      id: "p9",
      name: "Old Shop",
      defaultCategoryId: null,
      aliases: [],
    });
    expect(s.payees.findOne).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "p9", userId: USER } }),
    );
  });

  it("is null for a payee that is not the caller's", async () => {
    const s = setup();
    s.payees.findOne.mockResolvedValue(null);
    await expect(loadOwnedPayee(s.m, USER, "p-other")).resolves.toBeNull();
  });
});

describe("loadUsage", () => {
  it("counts no void row", async () => {
    const s = setup();
    s.builder.getRawMany.mockResolvedValue([]);
    await loadUsage(s.m, USER, "category_id", ["c1"]);
    expect(s.builder.andWhere).toHaveBeenCalledWith(
      "(t.status IS NULL OR t.status <> :void)",
      { void: TransactionStatus.VOID },
    );
  });

  it("asks about at most USAGE_MAX_IDS distinct ids, the first given", async () => {
    const s = setup();
    s.builder.getRawMany.mockResolvedValue([]);
    const ids = Array.from({ length: 70_000 }, (_v, i) => `p${i % 69_000}`);
    await loadUsage(s.m, USER, "payee_id", ids);
    const [, params] = s.builder.andWhere.mock.calls.find(([sql]) =>
      String(sql).includes("IN (:...ids)"),
    )!;
    expect(params.ids).toHaveLength(USAGE_MAX_IDS);
    expect(params.ids[0]).toBe("p0");
    expect(params.ids[USAGE_MAX_IDS - 1]).toBe(`p${USAGE_MAX_IDS - 1}`);
    expect(new Set(params.ids).size).toBe(USAGE_MAX_IDS);
  });

  it("counts the caller's rows per id, with the ids as a parameter", async () => {
    const s = setup();
    s.builder.getRawMany.mockResolvedValue([
      { id: "p1", count: "7" },
      { id: "p2", count: 2 },
    ]);
    const usage = await loadUsage(s.m, USER, "payee_id", ["p1", "p2"]);
    expect([...usage.entries()]).toEqual([
      ["p1", 7],
      ["p2", 2],
    ]);
    expect(s.builder.where).toHaveBeenCalledWith("t.user_id = :userId", {
      userId: USER,
    });
    expect(s.builder.andWhere).toHaveBeenCalledWith("t.payee_id IN (:...ids)", {
      ids: ["p1", "p2"],
    });
  });

  it("asks nothing for no ids", async () => {
    const s = setup();
    await expect(loadUsage(s.m, USER, "account_id", [])).resolves.toEqual(
      new Map(),
    );
    expect(s.transactions.createQueryBuilder).not.toHaveBeenCalled();
  });
});

describe("loadPayeeHistory", () => {
  it("reads the payee's last non-void, non-transfer rows, and the unsplit ones for categories", async () => {
    const s = setup();
    s.transactions.find
      .mockResolvedValueOnce([
        { id: "t1", accountId: "a1", amount: "-12.50000000" },
        { id: "t2", accountId: "a2", amount: "100" },
      ])
      .mockResolvedValueOnce([
        { id: "t1", categoryId: "c1" },
        { id: "t3", categoryId: null },
      ]);

    const history = await loadPayeeHistory(s.m, USER, "p1");

    expect(history).toEqual({
      recent: [
        { accountId: "a1", amount: -12.5 },
        { accountId: "a2", amount: 100 },
      ],
      categoryIds: ["c1", null],
    });
    const [recent, unsplit] = s.transactions.find.mock.calls.map(
      ([options]) => options,
    );
    expect(recent.take).toBe(PAYEE_HISTORY_ROWS);
    expect(recent.order).toEqual({
      transactionDate: "DESC",
      createdAt: "DESC",
      id: "DESC",
    });
    expect(unsplit.order).toEqual(recent.order);
    expect(recent.where).toMatchObject({
      userId: USER,
      payeeId: "p1",
      isTransfer: false,
    });
    const status = recent.where.status as FindOperator<string>;
    expect(status.type).toBe("not");
    expect(status.value).toBe(TransactionStatus.VOID);
    expect(unsplit.where).toMatchObject({ isSplit: false, isTransfer: false });
    expect(unsplit.take).toBe(PAYEE_HISTORY_ROWS);
  });
});

describe("loadMostRecentAccountId", () => {
  it("is the account of the caller's newest created row among the eligible", async () => {
    const s = setup();
    s.transactions.findOne.mockResolvedValue({ id: "t1", accountId: "a2" });
    await expect(
      loadMostRecentAccountId(s.m, USER, ["a1", "a2"]),
    ).resolves.toBe("a2");
    const [options] = s.transactions.findOne.mock.calls[0];
    // A transfer's two legs share `created_at`; `id` makes the pick stable.
    expect(options.order).toEqual({ createdAt: "DESC", id: "DESC" });
    expect(options.where.userId).toBe(USER);
  });

  it("is null without eligible accounts or rows", async () => {
    const s = setup();
    await expect(loadMostRecentAccountId(s.m, USER, [])).resolves.toBeNull();
    expect(s.transactions.findOne).not.toHaveBeenCalled();
    s.transactions.findOne.mockResolvedValue(null);
    await expect(
      loadMostRecentAccountId(s.m, USER, ["a1"]),
    ).resolves.toBeNull();
  });
});
