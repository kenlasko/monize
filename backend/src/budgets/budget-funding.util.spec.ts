import {
  budgetFunding,
  isTransferFundingLine,
  periodCategoryIncome,
} from "./budget-funding.util";

// docs/specs/transfer-categories.md section 6.2.
describe("isTransferFundingLine", () => {
  const line = (overrides: Record<string, unknown>) =>
    ({
      isIncome: true,
      isTransfer: false,
      transferAccountId: null,
      category: null,
      ...overrides,
    }) as Parameters<typeof isTransferFundingLine>[0];

  it("is a transfer income line or an income line on a Transfer category", () => {
    expect(
      isTransferFundingLine(
        line({ isTransfer: true, transferAccountId: "acc-hisa" }),
      ),
    ).toBe(true);
    expect(
      isTransferFundingLine(line({ category: { categoryType: "transfer" } })),
    ).toBe(true);
  });

  it("is never an income line on an Income or Expense category", () => {
    expect(
      isTransferFundingLine(line({ category: { categoryType: "income" } })),
    ).toBe(false);
    expect(
      isTransferFundingLine(line({ category: { categoryType: "expense" } })),
    ).toBe(false);
    // A category of unknown type is not read as a transfer.
    expect(isTransferFundingLine(line({ category: {} }))).toBe(false);
  });

  it("is never an outgoing line", () => {
    expect(
      isTransferFundingLine(
        line({ isIncome: false, category: { categoryType: "transfer" } }),
      ),
    ).toBe(false);
    expect(
      isTransferFundingLine(
        line({
          isIncome: false,
          isTransfer: true,
          transferAccountId: "acc-hisa",
        }),
      ),
    ).toBe(false);
  });
});

describe("budgetFunding", () => {
  it("splits section 6.5's income into Actual Income and Transfer Funding", () => {
    // L1 Salary 5,000; L6 Transfers from Reserve 1,000; L7 Reserve draws
    // 400; the toggle 250.
    expect(
      budgetFunding(
        [
          { actual: 5000, isTransferFunding: false },
          { actual: 1000, isTransferFunding: true },
          { actual: 400, isTransferFunding: true },
        ],
        250,
      ),
    ).toEqual({
      categoryIncome: 5000,
      transferFunding: 1650,
      totalIncome: 6650,
    });
  });

  it("keeps the total of a budget with no transfer funding", () => {
    expect(
      budgetFunding([{ actual: 1234.5678, isTransferFunding: false }], 0),
    ).toEqual({
      categoryIncome: 1234.5678,
      transferFunding: 0,
      totalIncome: 1234.5678,
    });
  });
});

describe("periodCategoryIncome", () => {
  it("is the stored total less its Transfer Funding part (section 6.6)", () => {
    expect(
      periodCategoryIncome({
        actualIncome: "6650.00000000",
        transferFunding: "1650.00000000",
      }),
    ).toBe(5000);
  });

  it("is unknown, not the total, while the part is unknown (section 10)", () => {
    expect(periodCategoryIncome({ actualIncome: 6650 })).toBeNull();
    expect(
      periodCategoryIncome({ actualIncome: 6650, transferFunding: null }),
    ).toBeNull();
  });
});
