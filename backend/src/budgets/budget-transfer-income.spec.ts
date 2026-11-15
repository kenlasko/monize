import {
  budgetTransfersInAsIncome,
  CategorySpending,
  emptyCategorySpending,
  isTransferIncomeLine,
  queryCategorySpending,
  queryCategorySpendingBuckets,
  resolveBudgetIncome,
  resolveCategorySpent,
  resolveCategorySpentOrNull,
  resolveOutsideTransferIncome,
} from "./budget-spending.util";
import { BudgetCategory } from "./entities/budget-category.entity";

/**
 * Issue #2141 (`docs/specs/budget-transfer-income.md`): a transfer income line
 * and `config.transfersInAsIncome`. The SQL's direction and netting are
 * proven against PostgreSQL in
 * `test/integration/budget-transfer-income.integration.spec.ts`; these cases
 * hold the routing of rows into the maps and the resolvers over them.
 */
function line(overrides: Partial<BudgetCategory> = {}): BudgetCategory {
  return {
    id: "bc-1",
    budgetId: "b-1",
    categoryId: null,
    isTransfer: true,
    transferAccountId: "hisa",
    isIncome: true,
    amount: 2000,
    ...overrides,
  } as unknown as BudgetCategory;
}

function spendingOf(overrides: Partial<CategorySpending> = {}) {
  return { ...emptyCategorySpending("CAD"), ...overrides };
}

function makeQbReturning(rows: any[]) {
  const qb: any = {
    select: jest.fn().mockReturnThis(),
    addSelect: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    groupBy: jest.fn().mockReturnThis(),
    addGroupBy: jest.fn().mockReturnThis(),
    innerJoin: jest.fn().mockReturnThis(),
    setParameter: jest.fn().mockReturnThis(),
    getRawMany: jest.fn().mockResolvedValue(rows),
  };
  return qb;
}

function makeManager(config: unknown) {
  return {
    query: jest
      .fn()
      .mockImplementation(async (sql: string) =>
        sql.includes("FROM budgets") ? [{ currency_code: "CAD", config }] : [],
      ),
  };
}

const row = (key: string, total: string, txDate = "2026-01-10") => ({
  key,
  currencyCode: "CAD",
  txDate,
  total,
});

describe("budgetTransfersInAsIncome", () => {
  it("is on only for a literal true", () => {
    expect(budgetTransfersInAsIncome({ transfersInAsIncome: true })).toBe(true);
    expect(budgetTransfersInAsIncome({ transfersInAsIncome: "true" })).toBe(
      false,
    );
    expect(budgetTransfersInAsIncome({})).toBe(false);
    expect(budgetTransfersInAsIncome(null)).toBe(false);
  });
});

describe("isTransferIncomeLine", () => {
  it("needs a transfer, an account and the income flag", () => {
    expect(isTransferIncomeLine(line())).toBe(true);
    expect(isTransferIncomeLine(line({ isIncome: false }))).toBe(false);
    expect(isTransferIncomeLine(line({ transferAccountId: null }))).toBe(false);
    expect(
      isTransferIncomeLine(line({ isTransfer: false, categoryId: "cat-1" })),
    ).toBe(false);
  });
});

describe("resolving a transfer income line", () => {
  it("reads the net in from its source, never the outgoing map", () => {
    const bc = line();
    expect(
      resolveCategorySpent(
        bc,
        new Map(),
        new Map([["hisa", 999]]),
        new Map([["hisa", 1500]]),
      ),
    ).toBe(1500);
  });

  it("clamps a net outflow to the source at zero", () => {
    expect(
      resolveCategorySpent(
        line(),
        new Map(),
        new Map(),
        new Map([["hisa", -500]]),
      ),
    ).toBe(0);
  });

  it("is unknown when a row of its source had no rate", () => {
    const spending = spendingOf({
      transferIncomeMap: new Map([["hisa", 100]]),
      incompleteTransferIncomeAccountIds: new Set(["hisa"]),
    });
    expect(resolveCategorySpentOrNull(line(), spending)).toBeNull();
    expect(
      resolveCategorySpentOrNull(
        line(),
        spendingOf({ transferIncomeMap: new Map([["hisa", 100]]) }),
      ),
    ).toBe(100);
  });
});

describe("resolveBudgetIncome", () => {
  const salary = {
    id: "bc-s",
    budgetId: "b-1",
    categoryId: "salary",
    isTransfer: false,
    transferAccountId: null,
    isIncome: true,
  } as unknown as BudgetCategory;

  it("nets categories, transfer income lines and the toggle's figure", () => {
    const spending = spendingOf({
      spendingMap: new Map([["salary", 3000]]),
      transferIncomeMap: new Map([["hisa", 1500]]),
      outsideTransferIncome: 300,
    });
    expect(resolveBudgetIncome([salary, line()], spending)).toBe(4800);
  });

  it("lets a net outflow offset other income, clamping the whole at zero", () => {
    expect(
      resolveBudgetIncome(
        [salary, line()],
        spendingOf({
          spendingMap: new Map([["salary", 100]]),
          transferIncomeMap: new Map([["hisa", -400]]),
        }),
      ),
    ).toBe(0);
    expect(
      resolveBudgetIncome(
        [salary],
        spendingOf({
          spendingMap: new Map([["salary", 1000]]),
          outsideTransferIncome: -250,
        }),
      ),
    ).toBe(750);
  });
});

describe("resolveOutsideTransferIncome", () => {
  it("clamps the toggle's net figure at zero, as a line's", () => {
    expect(
      resolveOutsideTransferIncome(spendingOf({ outsideTransferIncome: 42 })),
    ).toBe(42);
    expect(
      resolveOutsideTransferIncome(spendingOf({ outsideTransferIncome: -42 })),
    ).toBe(0);
  });
});

describe("queryCategorySpending with transfers in", () => {
  it("keys a transfer income line's rows by source, signed, apart from outgoing lines", async () => {
    const incomingParent = makeQbReturning([
      row("hisa", "2000"),
      row("hisa", "-500", "2026-01-20"),
    ]);
    const incomingSplit = makeQbReturning([row("hisa", "100")]);
    const txRepo: any = {
      manager: makeManager({ excludedAccountIds: ["hisa"] }),
      createQueryBuilder: jest.fn().mockReturnValue(incomingParent),
    };
    const splitRepo: any = {
      createQueryBuilder: jest.fn().mockReturnValue(incomingSplit),
    };

    const result = await queryCategorySpending(
      txRepo,
      splitRepo,
      "user-1",
      [line()],
      "2026-01-01",
      "2026-01-31",
    );

    expect(result.transferIncomeMap.get("hisa")).toBe(1600);
    expect(result.transferSpendingMap.size).toBe(0);
    // The toggle is off: nothing is swept from the excluded accounts.
    expect(result.outsideTransferIncome).toBe(0);
    // Both directions are read: no `amount < 0` filter on the incoming read.
    expect(incomingParent.andWhere).not.toHaveBeenCalledWith("t.amount < 0");
    expect(incomingParent.andWhere).toHaveBeenCalledWith(
      "lt.account_id IN (:...sourceAccountIds)",
      { sourceAccountIds: ["hisa"] },
    );
    expect(incomingSplit.andWhere).toHaveBeenCalledWith(
      "s.transfer_account_id IN (:...sourceAccountIds)",
      { sourceAccountIds: ["hisa"] },
    );
    // A leg in an excluded account is not the budget's.
    expect(incomingParent.andWhere).toHaveBeenCalledWith(
      "t.account_id NOT IN (:...excludedAccountIds)",
      { excludedAccountIds: ["hisa"] },
    );
  });

  it("sweeps every excluded account no transfer line names into one figure", async () => {
    const outgoingParent = makeQbReturning([]);
    const outgoingSplit = makeQbReturning([]);
    const incomingParent = makeQbReturning([
      row("hisa", "2000"),
      row("rrsp", "300"),
    ]);
    const incomingSplit = makeQbReturning([row("rrsp", "-100")]);
    const txRepo: any = {
      manager: makeManager({
        excludedAccountIds: ["hisa", "rrsp", "tfsa"],
        transfersInAsIncome: true,
      }),
      createQueryBuilder: jest
        .fn()
        .mockReturnValueOnce(outgoingParent)
        .mockReturnValueOnce(incomingParent),
    };
    const splitRepo: any = {
      createQueryBuilder: jest
        .fn()
        .mockReturnValueOnce(outgoingSplit)
        .mockReturnValueOnce(incomingSplit),
    };

    const result = await queryCategorySpending(
      txRepo,
      splitRepo,
      "user-1",
      // HISA has its own income line; TFSA is a savings destination.
      [
        line(),
        line({
          id: "bc-2",
          transferAccountId: "tfsa",
          isIncome: false,
        }),
      ],
      "2026-01-01",
      "2026-01-31",
    );

    expect(incomingParent.andWhere).toHaveBeenCalledWith(
      "lt.account_id IN (:...sourceAccountIds)",
      { sourceAccountIds: ["hisa", "rrsp"] },
    );
    expect(result.transferIncomeMap.get("hisa")).toBe(2000);
    expect(result.transferIncomeMap.has("rrsp")).toBe(false);
    expect(result.outsideTransferIncome).toBe(200);
    expect(result.outsideTransferIncomeComplete).toBe(true);
  });

  it("leaves out an account the budget's own transfer line names when the caller passes a subset", async () => {
    // The savings rate passes only income and category lines; the budget's
    // TFSA savings line still keeps TFSA out of the toggle's sweep.
    const incomingParent = makeQbReturning([row("rrsp", "300")]);
    const incomingSplit = makeQbReturning([]);
    const txRepo: any = {
      manager: {
        query: jest.fn().mockImplementation(async (sql: string) =>
          sql.includes("FROM budgets")
            ? [
                {
                  currency_code: "CAD",
                  config: {
                    excludedAccountIds: ["rrsp", "tfsa"],
                    transfersInAsIncome: true,
                  },
                  transfer_account_ids: ["tfsa"],
                },
              ]
            : [],
        ),
      },
      createQueryBuilder: jest.fn().mockReturnValueOnce(incomingParent),
    };
    const splitRepo: any = {
      createQueryBuilder: jest.fn().mockReturnValueOnce(incomingSplit),
    };

    const result = await queryCategorySpending(
      txRepo,
      splitRepo,
      "user-1",
      [line({ id: "bc-c", isTransfer: false, transferAccountId: null })],
      "2026-01-01",
      "2026-01-31",
    );

    expect(incomingParent.andWhere).toHaveBeenCalledWith(
      "lt.account_id IN (:...sourceAccountIds)",
      { sourceAccountIds: ["rrsp"] },
    );
    expect(result.outsideTransferIncome).toBe(300);
  });

  it("flags the toggle's figure incomplete when a row had no rate", async () => {
    const txRepo: any = {
      manager: makeManager({
        excludedAccountIds: ["rrsp"],
        transfersInAsIncome: true,
      }),
      createQueryBuilder: jest
        .fn()
        .mockImplementation(() =>
          makeQbReturning([
            row("rrsp", "50"),
            { ...row("rrsp", "1000"), currencyCode: "JPY" },
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
      [line({ isTransfer: false, transferAccountId: null, categoryId: "c" })],
      "2026-01-01",
      "2026-01-31",
    );

    expect(result.outsideTransferIncome).toBe(50);
    expect(result.outsideTransferIncomeComplete).toBe(false);
    expect(result.missingRatePairs).toEqual(["JPY->CAD"]);
  });

  it("buckets the transfer income figures like every other", async () => {
    const txRepo: any = {
      manager: makeManager({
        excludedAccountIds: ["hisa", "rrsp"],
        transfersInAsIncome: true,
      }),
      createQueryBuilder: jest
        .fn()
        .mockImplementation(() =>
          makeQbReturning([
            row("hisa", "2000", "2026-01-05"),
            row("rrsp", "300", "2026-02-05"),
          ]),
        ),
    };
    const splitRepo: any = {
      createQueryBuilder: jest
        .fn()
        .mockImplementation(() => makeQbReturning([])),
    };

    const { buckets } = await queryCategorySpendingBuckets(
      txRepo,
      splitRepo,
      "user-1",
      [line()],
      "2026-01-01",
      "2026-02-28",
      (txDate) => txDate.slice(0, 7),
    );

    expect(buckets.get("2026-01")!.transferIncomeMap.get("hisa")).toBe(2000);
    expect(buckets.get("2026-01")!.outsideTransferIncome).toBe(0);
    expect(buckets.get("2026-02")!.transferIncomeMap.size).toBe(0);
    expect(buckets.get("2026-02")!.outsideTransferIncome).toBe(300);
  });

  it("runs no incoming read when nothing counts transfers in", async () => {
    const txRepo: any = {
      manager: makeManager({ excludedAccountIds: ["hisa"] }),
      createQueryBuilder: jest
        .fn()
        .mockImplementation(() => makeQbReturning([])),
    };
    const splitRepo: any = {
      createQueryBuilder: jest
        .fn()
        .mockImplementation(() => makeQbReturning([])),
    };

    await queryCategorySpending(
      txRepo,
      splitRepo,
      "user-1",
      [line({ isTransfer: false, transferAccountId: null, categoryId: "c" })],
      "2026-01-01",
      "2026-01-31",
    );

    // The category's direct and split reads only.
    expect(txRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
    expect(splitRepo.createQueryBuilder).toHaveBeenCalledTimes(1);
  });

  it("counts the toggle's figure for a budget with no line at all, given its id", async () => {
    const incomingParent = makeQbReturning([row("hisa", "1500")]);
    const incomingSplit = makeQbReturning([]);
    const txRepo: any = {
      manager: makeManager({
        excludedAccountIds: ["hisa"],
        transfersInAsIncome: true,
      }),
      createQueryBuilder: jest.fn().mockReturnValueOnce(incomingParent),
    };
    const splitRepo: any = {
      createQueryBuilder: jest.fn().mockReturnValueOnce(incomingSplit),
    };

    const result = await queryCategorySpending(
      txRepo,
      splitRepo,
      "user-1",
      [],
      "2026-01-01",
      "2026-01-31",
      "b-1",
    );

    expect(txRepo.manager.query).toHaveBeenCalledWith(
      expect.stringContaining("FROM budgets b WHERE b.id = $1"),
      ["b-1"],
    );
    expect(result.currency).toBe("CAD");
    expect(result.outsideTransferIncome).toBe(1500);
  });

  it("reads nothing for a budget with no line and no id", async () => {
    const txRepo: any = {
      manager: makeManager({ transfersInAsIncome: true }),
      createQueryBuilder: jest.fn(),
    };

    const result = await queryCategorySpending(
      txRepo,
      { createQueryBuilder: jest.fn() } as any,
      "user-1",
      [],
      "2026-01-01",
      "2026-01-31",
    );

    expect(txRepo.manager.query).not.toHaveBeenCalled();
    expect(result.outsideTransferIncome).toBe(0);
  });
});
