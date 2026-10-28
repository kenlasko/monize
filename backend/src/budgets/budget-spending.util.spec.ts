jest.mock("../accruals/reporting-money", () =>
  jest
    .requireActual("../test-helpers/reporting-read-testing")
    .reportingMoneyMockModule(),
);
jest.mock("../accruals/reporting-basis", () =>
  jest
    .requireActual("../test-helpers/reporting-read-testing")
    .reportingBasisMockModule(),
);
jest.mock("../accruals/reporting-query", () =>
  jest
    .requireActual("../test-helpers/reporting-read-testing")
    .reportingQueryMockModule(),
);
jest.mock("../accruals/reporting-basis.interceptor", () =>
  jest
    .requireActual("../test-helpers/reporting-read-testing")
    .reportingInterceptorMockModule(),
);

import {
  budgetExcludedAccountIds,
  CategorySpending,
  excludeBudgetAccounts,
  queryCategorySpending,
  resolveCategoryName,
  resolveCategorySpent,
  resolveCategorySpentOrNull,
} from "./budget-spending.util";
import { BudgetCategory } from "./entities/budget-category.entity";

function makeBudgetCategory(
  overrides: Partial<BudgetCategory> = {},
): BudgetCategory {
  return {
    id: "bc-1",
    budgetId: "b-1",
    categoryId: "cat-1",
    isTransfer: false,
    transferAccountId: null,
    isIncome: false,
    amount: 100,
    ...overrides,
  } as unknown as BudgetCategory;
}

describe("budgetExcludedAccountIds", () => {
  it("reads nothing excluded from a missing or empty config", () => {
    expect(budgetExcludedAccountIds(null)).toEqual([]);
    expect(budgetExcludedAccountIds({})).toEqual([]);
  });

  it("reads nothing excluded when the value is not an array", () => {
    expect(budgetExcludedAccountIds({ excludedAccountIds: "x" })).toEqual([]);
  });

  it("keeps only the string entries of the array", () => {
    expect(
      budgetExcludedAccountIds({ excludedAccountIds: ["a", 3, "b"] }),
    ).toEqual(["a", "b"]);
  });
});

describe("excludeBudgetAccounts", () => {
  it("adds no clause when no account is excluded", () => {
    const qb: any = { andWhere: jest.fn().mockReturnThis() };

    expect(excludeBudgetAccounts(qb, [])).toBe(qb);
    expect(qb.andWhere).not.toHaveBeenCalled();
  });

  it("adds the NOT IN clause with the ids as its parameter", () => {
    const qb: any = { andWhere: jest.fn().mockReturnThis() };

    expect(excludeBudgetAccounts(qb, ["a"])).toBe(qb);
    expect(qb.andWhere).toHaveBeenCalledWith(
      "t.account_id NOT IN (:...excludedAccountIds)",
      { excludedAccountIds: ["a"] },
    );
  });
});

describe("resolveCategoryName", () => {
  it("returns the transfer account name for transfer categories", () => {
    const bc = makeBudgetCategory({
      isTransfer: true,
      transferAccountId: "acc-1",
      transferAccount: { name: "Savings" },
    } as any);
    expect(resolveCategoryName(bc)).toBe("Savings");
  });

  it("returns 'Transfer' fallback when transfer account name is missing", () => {
    const bc = makeBudgetCategory({
      isTransfer: true,
      transferAccountId: "acc-1",
      transferAccount: undefined,
    } as any);
    expect(resolveCategoryName(bc)).toBe("Transfer");
  });

  it("falls through to category logic when isTransfer but transferAccountId is missing", () => {
    const bc = makeBudgetCategory({
      isTransfer: true,
      transferAccountId: null,
      category: { name: "Groceries" },
    } as any);
    expect(resolveCategoryName(bc)).toBe("Groceries");
  });

  it("returns 'parent: child' when category has a parent", () => {
    const bc = makeBudgetCategory({
      category: {
        name: "Restaurants",
        parent: { name: "Food" },
      },
    } as any);
    expect(resolveCategoryName(bc)).toBe("Food: Restaurants");
  });

  it("returns the bare category name when no parent is set", () => {
    const bc = makeBudgetCategory({
      category: { name: "Travel" },
    } as any);
    expect(resolveCategoryName(bc)).toBe("Travel");
  });

  it("returns 'Uncategorized' when category is null", () => {
    const bc = makeBudgetCategory({ category: null } as any);
    expect(resolveCategoryName(bc)).toBe("Uncategorized");
  });
});

describe("resolveCategorySpent", () => {
  it("returns the transfer spending for transfer categories", () => {
    const bc = makeBudgetCategory({
      isTransfer: true,
      transferAccountId: "acc-1",
    } as any);
    const transfers = new Map([["acc-1", 250.5]]);
    expect(resolveCategorySpent(bc, new Map(), transfers)).toBe(250.5);
  });

  it("returns 0 when transfer account has no recorded spending", () => {
    const bc = makeBudgetCategory({
      isTransfer: true,
      transferAccountId: "acc-2",
    } as any);
    expect(resolveCategorySpent(bc, new Map(), new Map())).toBe(0);
  });

  it("returns 0 for expense category with no entry in the spending map", () => {
    const bc = makeBudgetCategory();
    expect(resolveCategorySpent(bc, new Map(), new Map())).toBe(0);
  });

  it("returns the negated amount for expense categories (expenses are negative in DB)", () => {
    const bc = makeBudgetCategory();
    const spending = new Map([["cat-1", -123.45]]);
    expect(resolveCategorySpent(bc, spending, new Map())).toBe(123.45);
  });

  it("clamps to 0 when refunds exceed spending for expense categories", () => {
    const bc = makeBudgetCategory();
    const spending = new Map([["cat-1", 50]]); // refunds > spending => positive raw
    expect(resolveCategorySpent(bc, spending, new Map())).toBe(0);
  });

  it("returns the positive amount for income categories", () => {
    const bc = makeBudgetCategory({ isIncome: true } as any);
    const spending = new Map([["cat-1", 1500]]);
    expect(resolveCategorySpent(bc, spending, new Map())).toBe(1500);
  });

  it("clamps to 0 when income deductions exceed income", () => {
    const bc = makeBudgetCategory({ isIncome: true } as any);
    const spending = new Map([["cat-1", -75]]);
    expect(resolveCategorySpent(bc, spending, new Map())).toBe(0);
  });

  it("returns 0 when categoryId is missing", () => {
    const bc = makeBudgetCategory({ categoryId: null } as any);
    expect(resolveCategorySpent(bc, new Map(), new Map())).toBe(0);
  });
});

describe("queryCategorySpending", () => {
  function makeQbReturning(rows: any[]) {
    const qb: any = {
      select: jest.fn().mockReturnThis(),
      addSelect: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      addGroupBy: jest.fn().mockReturnThis(),
      innerJoin: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(rows),
    };
    return qb;
  }

  /** A manager whose budget is CAD and whose rate table is empty. */
  function makeManager(rateRows: any[] = []) {
    return {
      query: jest
        .fn()
        .mockImplementation(async (sql: string) =>
          sql.includes("FROM budgets") ? [{ currency_code: "CAD" }] : rateRows,
        ),
    };
  }

  it("returns empty maps when there are no budget categories", async () => {
    const txRepo = { createQueryBuilder: jest.fn(), manager: makeManager() };
    const splitRepo = { createQueryBuilder: jest.fn() };

    const result = await queryCategorySpending(
      txRepo as any,
      splitRepo as any,
      "user-1",
      [],
      "2026-01-01",
      "2026-01-31",
      "USD",
    );

    expect(result.spendingMap.size).toBe(0);
    expect(result.transferSpendingMap.size).toBe(0);
    expect(txRepo.createQueryBuilder).not.toHaveBeenCalled();
    expect(splitRepo.createQueryBuilder).not.toHaveBeenCalled();
  });

  it("passes the budget's excluded accounts into the direct and split queries", async () => {
    const directQb = makeQbReturning([]);
    const splitQb = makeQbReturning([]);
    const manager = {
      query: jest.fn().mockImplementation(async (sql: string) =>
        sql.includes("FROM budgets")
          ? [
              {
                currency_code: "CAD",
                config: { excludedAccountIds: ["acc-x"] },
              },
            ]
          : [],
      ),
    };
    const txRepo: any = {
      manager,
      createQueryBuilder: jest.fn().mockReturnValue(directQb),
    };
    const splitRepo: any = {
      createQueryBuilder: jest.fn().mockReturnValue(splitQb),
    };

    await queryCategorySpending(
      txRepo,
      splitRepo,
      "user-1",
      [makeBudgetCategory({ categoryId: "cat-1" })],
      "2026-01-01",
      "2026-01-31",
    );

    const clause = "t.account_id NOT IN (:...excludedAccountIds)";
    const params = { excludedAccountIds: ["acc-x"] };
    expect(directQb.andWhere).toHaveBeenCalledWith(clause, params);
    expect(splitQb.andWhere).toHaveBeenCalledWith(clause, params);
  });

  it("aggregates transaction and split spending for category budgets", async () => {
    const txRepo: any = {
      manager: makeManager(),
      createQueryBuilder: jest.fn().mockImplementation(() =>
        makeQbReturning([
          {
            key: "cat-1",
            currencyCode: "CAD",
            txDate: "2026-01-10",
            total: "-50",
          },
        ]),
      ),
    };
    const splitRepo: any = {
      createQueryBuilder: jest.fn().mockImplementation(() =>
        makeQbReturning([
          {
            key: "cat-1",
            currencyCode: "CAD",
            txDate: "2026-01-10",
            total: "-25",
          },
        ]),
      ),
    };

    const result = await queryCategorySpending(
      txRepo,
      splitRepo,
      "user-1",
      [makeBudgetCategory({ categoryId: "cat-1" })],
      "2026-01-01",
      "2026-01-31",
      "USD",
    );

    expect(result.spendingMap.get("cat-1")).toBe(-75);
  });

  it("aggregates transfer spending separately for transfer budgets", async () => {
    const txRepo: any = {
      manager: makeManager(),
      createQueryBuilder: jest
        .fn()
        // first call: category SUM (no category, returns nothing as no categoryId budgets)
        .mockReturnValueOnce(
          makeQbReturning([
            {
              key: "acc-1",
              currencyCode: "CAD",
              txDate: "2026-01-10",
              total: "300",
            },
          ]),
        ),
    };
    const splitRepo: any = {
      createQueryBuilder: jest
        .fn()
        .mockImplementation(() => makeQbReturning([])),
    };

    const result = await queryCategorySpending(
      txRepo,
      splitRepo,
      "user-1",
      [
        makeBudgetCategory({
          categoryId: null,
          isTransfer: true,
          transferAccountId: "acc-1",
        } as any),
      ],
      "2026-01-01",
      "2026-01-31",
      "USD",
    );

    expect(result.transferSpendingMap.get("acc-1")).toBe(300);
  });

  it("includes a transfer that is a child of a split (P5-007)", async () => {
    // A monthly transfer budget to Savings of 100, spent as one mixed line:
    // a -100 parent with a -60 Groceries child and a -40 transfer child.
    //
    // The transfer query keys off `is_transfer` on the PARENT, and a split
    // parent is not a transfer row -- so this progress was invisible and the
    // budget read 0 of 100 spent. Savings, debt-payment and
    // investment-contribution budgets all under-reported whenever the user
    // recorded the transfer alongside a category on one transaction.
    const txRepo: any = {
      manager: makeManager(),
      createQueryBuilder: jest
        .fn()
        // No plain transfer rows in the period.
        .mockImplementation(() => makeQbReturning([])),
    };
    const splitRepo: any = {
      createQueryBuilder: jest.fn().mockImplementation(() =>
        makeQbReturning([
          {
            key: "acc-1",
            currencyCode: "CAD",
            txDate: "2026-01-10",
            total: "40",
          },
        ]),
      ),
    };

    const result = await queryCategorySpending(
      txRepo,
      splitRepo,
      "user-1",
      [
        makeBudgetCategory({
          categoryId: null,
          isTransfer: true,
          transferAccountId: "acc-1",
        } as any),
      ],
      "2026-01-01",
      "2026-01-31",
      "USD",
    );

    expect(result.transferSpendingMap.get("acc-1")).toBe(40);
  });

  it("sums a plain transfer and a split transfer to the same account", async () => {
    // Counted once each, not once in total and not twice: the split query reads
    // the split row's own target, and a counterpart row is not itself a split.
    const txRepo: any = {
      manager: makeManager(),
      createQueryBuilder: jest.fn().mockImplementation(() =>
        makeQbReturning([
          {
            key: "acc-1",
            currencyCode: "CAD",
            txDate: "2026-01-10",
            total: "300",
          },
        ]),
      ),
    };
    const splitRepo: any = {
      createQueryBuilder: jest.fn().mockImplementation(() =>
        makeQbReturning([
          {
            key: "acc-1",
            currencyCode: "CAD",
            txDate: "2026-01-10",
            total: "40",
          },
        ]),
      ),
    };

    const result = await queryCategorySpending(
      txRepo,
      splitRepo,
      "user-1",
      [
        makeBudgetCategory({
          categoryId: null,
          isTransfer: true,
          transferAccountId: "acc-1",
        } as any),
      ],
      "2026-01-01",
      "2026-01-31",
      "USD",
    );

    expect(result.transferSpendingMap.get("acc-1")).toBe(340);
  });

  it("treats null totals as 0", async () => {
    const txRepo: any = {
      manager: makeManager(),
      createQueryBuilder: jest.fn().mockImplementation(() =>
        makeQbReturning([
          {
            key: "cat-1",
            currencyCode: "CAD",
            txDate: "2026-01-10",
            total: null,
          },
        ]),
      ),
    };
    const splitRepo: any = {
      createQueryBuilder: jest.fn().mockImplementation(() =>
        makeQbReturning([
          {
            key: "cat-1",
            currencyCode: "CAD",
            txDate: "2026-01-10",
            total: null,
          },
        ]),
      ),
    };

    const result = await queryCategorySpending(
      txRepo,
      splitRepo,
      "user-1",
      [makeBudgetCategory({ categoryId: "cat-1" })],
      "2026-01-01",
      "2026-01-31",
    );

    expect(result.spendingMap.get("cat-1")).toBe(0);
  });

  it("converts a foreign row at its own date's rate and keeps the line complete", async () => {
    const txRepo: any = {
      manager: makeManager([
        {
          from_currency: "JPY",
          to_currency: "CAD",
          rate: "0.009",
          rate_date: "2026-01-01",
        },
      ]),
      createQueryBuilder: jest.fn().mockImplementation(() =>
        makeQbReturning([
          {
            key: "cat-1",
            currencyCode: "CAD",
            txDate: "2026-01-10",
            total: "-200",
          },
          {
            key: "cat-1",
            currencyCode: "JPY",
            txDate: "2026-01-12",
            total: "-10000",
          },
        ]),
      ),
    };
    const splitRepo: any = {
      createQueryBuilder: jest
        .fn()
        .mockImplementation(() => makeQbReturning([])),
    };

    const result = await queryCategorySpending(
      txRepo,
      splitRepo,
      "user-1",
      [makeBudgetCategory({ categoryId: "cat-1" })],
      "2026-01-01",
      "2026-01-31",
    );

    expect(result.currency).toBe("CAD");
    expect(result.spendingMap.get("cat-1")).toBe(-290);
    expect(result.incompleteCategoryIds.size).toBe(0);
    expect(result.missingRatePairs).toEqual([]);
  });

  it("keeps the known part and names the pair when a rate is missing", async () => {
    const txRepo: any = {
      manager: makeManager(),
      createQueryBuilder: jest.fn().mockImplementation(() =>
        makeQbReturning([
          {
            key: "cat-1",
            currencyCode: "CAD",
            txDate: "2026-01-10",
            total: "-200",
          },
          {
            key: "cat-1",
            currencyCode: "JPY",
            txDate: "2026-01-12",
            total: "-10000",
          },
        ]),
      ),
    };
    const splitRepo: any = {
      createQueryBuilder: jest
        .fn()
        .mockImplementation(() => makeQbReturning([])),
    };

    const result = await queryCategorySpending(
      txRepo,
      splitRepo,
      "user-1",
      [makeBudgetCategory({ categoryId: "cat-1" })],
      "2026-01-01",
      "2026-01-31",
      "USD",
    );

    expect(result.spendingMap.get("cat-1")).toBe(-200);
    expect([...result.incompleteCategoryIds]).toEqual(["cat-1"]);
    expect(result.missingRatePairs).toEqual(["JPY->CAD"]);
  });
});

describe("resolveCategorySpentOrNull", () => {
  function spendingOf(
    overrides: Partial<CategorySpending> = {},
  ): CategorySpending {
    return {
      spendingMap: new Map(),
      transferSpendingMap: new Map(),
      currency: "CAD",
      incompleteCategoryIds: new Set(),
      incompleteTransferAccountIds: new Set(),
      missingRatePairs: [],
      ...overrides,
    };
  }

  it("returns null for an incomplete category", () => {
    const spending = spendingOf({
      spendingMap: new Map([["cat-1", -200]]),
      incompleteCategoryIds: new Set(["cat-1"]),
    });
    expect(
      resolveCategorySpentOrNull(makeBudgetCategory(), spending),
    ).toBeNull();
  });

  it("returns null for an incomplete transfer destination", () => {
    const bc = makeBudgetCategory({
      isTransfer: true,
      transferAccountId: "acc-1",
    } as any);
    const spending = spendingOf({
      incompleteTransferAccountIds: new Set(["acc-1"]),
    });
    expect(resolveCategorySpentOrNull(bc, spending)).toBeNull();
  });

  it("matches resolveCategorySpent for complete data, clamping included", () => {
    const spending = spendingOf({
      spendingMap: new Map([
        ["cat-1", -123.45],
        ["cat-2", 50],
        ["cat-3", 1500],
        ["cat-4", -75],
      ]),
      transferSpendingMap: new Map([["acc-1", 250.5]]),
    });
    const at = (o: Partial<BudgetCategory>) =>
      resolveCategorySpentOrNull(makeBudgetCategory(o), spending);
    expect(at({ categoryId: "cat-1" })).toBe(123.45);
    expect(at({ categoryId: "cat-2" })).toBe(0);
    expect(at({ categoryId: "cat-3", isIncome: true } as any)).toBe(1500);
    expect(at({ categoryId: "cat-4", isIncome: true } as any)).toBe(0);
    expect(at({ categoryId: null } as any)).toBe(0);
    expect(at({ isTransfer: true, transferAccountId: "acc-1" } as any)).toBe(
      250.5,
    );
    expect(at({ isTransfer: true, transferAccountId: "acc-9" } as any)).toBe(0);
  });
});
