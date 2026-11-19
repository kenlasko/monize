import { fullEquivalenceInput } from "./__fixtures__/trivia-pool.fixture";
import {
  buildEquivalenceTriviaFacts,
  type TriviaEquivalenceInput,
} from "./trivia-equivalence-facts";
import type { TriviaFact } from "./trivia.types";

const build = (over: Partial<TriviaEquivalenceInput> = {}) =>
  buildEquivalenceTriviaFacts({ ...fullEquivalenceInput(), ...over });
const ids = (facts: TriviaFact[]) => facts.map((f) => f.id);
const byId = (facts: TriviaFact[], id: string) =>
  facts.find((f) => f.id === id) as TriviaFact;

/** The fixture's ledger with its flows replaced. */
function withFlows(
  mutate: (
    flows: NonNullable<TriviaEquivalenceInput["ledger"]["incomeVsExpenses"]>,
  ) => void,
): TriviaEquivalenceInput["ledger"] {
  const ledger = fullEquivalenceInput().ledger;
  mutate(ledger.incomeVsExpenses as never);
  return ledger;
}

describe("buildEquivalenceTriviaFacts", () => {
  it("produces the four facts from the twelve-month data", () => {
    const facts = build();
    expect(ids(facts)).toEqual([
      "spendingPayeeInCategoryMonths",
      "spendingDailyAverage",
      "incomeKeptCoversDays",
      "investmentsGainInMonthsOfSpending",
    ]);
    // Top payee 5 over a category averaging 5 / 3 a month: 3 months.
    expect(byId(facts, "spendingPayeeInCategoryMonths").figures).toEqual({
      equivPayeeName: { kind: "text", value: "P" },
      equivPayeeAmount: { kind: "money", value: 5, currency: "CAD" },
      equivCategoryName: { kind: "text", value: "C" },
      equivCategoryMonths: { kind: "multiple", value: 3 },
    });
    // 2026-01-01 to 2026-10-31 is 304 days: 12 / 304 a day.
    expect(byId(facts, "spendingDailyAverage").figures).toEqual({
      dailyAverageSpent: { kind: "money", value: 0.0395, currency: "CAD" },
    });
    // floor(18 / (12 / 304)) = 456 days.
    expect(byId(facts, "incomeKeptCoversDays").figures).toEqual({
      keptCoversAmount: { kind: "money", value: 18, currency: "CAD" },
      keptCoversDays: { kind: "days", value: 456 },
    });
    // 100 gained over 12 / 3 = 4 a month: 25 months.
    expect(byId(facts, "investmentsGainInMonthsOfSpending").figures).toEqual({
      gainCoversAmount: { kind: "money", value: 100, currency: "CAD" },
      gainCoversMonths: { kind: "multiple", value: 25 },
    });
  });

  it("gives nothing with fewer than three months of flows", () => {
    const ledger = withFlows((f) => {
      f.data = f.data.slice(1);
    });
    expect(build({ ledger })).toEqual([]);
  });

  it.each([
    ["income", "income"],
    ["expenses", "expenses"],
    ["net", "net"],
  ] as const)("gives nothing when the %s total is null", (_n, key) => {
    const ledger = withFlows((f) => {
      (f.totals as unknown as Record<string, number | null>)[key] = null;
    });
    expect(build({ ledger })).toEqual([]);
  });

  it("gives nothing for a flows report with a currency that did not convert", () => {
    const ledger = withFlows((f) => {
      f.missingCurrencies = ["EUR"];
    });
    expect(build({ ledger })).toEqual([]);
  });

  it("leaves out the payee comparison when a report total is null", () => {
    const base = fullEquivalenceInput().ledger;
    const spending = ids(
      build({
        ledger: {
          ...base,
          spendingByCategory: {
            ...(base.spendingByCategory as object),
            totalSpending: null,
          } as never,
        },
      }),
    );
    expect(spending).not.toContain("spendingPayeeInCategoryMonths");
    const payee = ids(
      build({
        ledger: {
          ...base,
          spendingByPayee: {
            ...(base.spendingByPayee as object),
            totalSpending: null,
          } as never,
        },
      }),
    );
    expect(payee).not.toContain("spendingPayeeInCategoryMonths");
    expect(payee).toContain("spendingDailyAverage");
  });

  it("never names the report's unnamed bucket as the payee or category", () => {
    const base = fullEquivalenceInput().ledger;
    const facts = build({
      ledger: {
        ...base,
        spendingByPayee: {
          ...(base.spendingByPayee as object),
          data: [{ payeeId: null, payeeName: "Unknown", total: 5 }],
        } as never,
      },
    });
    expect(ids(facts)).not.toContain("spendingPayeeInCategoryMonths");
  });

  it("leaves out a payee comparison under half a month", () => {
    const base = fullEquivalenceInput().ledger;
    const facts = build({
      ledger: {
        ...base,
        spendingByPayee: {
          ...(base.spendingByPayee as object),
          data: [{ payeeId: "p", payeeName: "P", total: 0.5 }],
        } as never,
      },
    });
    // 0.5 / (5 / 3) = 0.3
    expect(ids(facts)).not.toContain("spendingPayeeInCategoryMonths");
  });

  it("leaves out the days kept covers when nothing was kept", () => {
    const ledger = withFlows((f) => {
      f.totals = { ...f.totals, net: 0 };
    });
    expect(ids(build({ ledger }))).not.toContain("incomeKeptCoversDays");
    const negative = withFlows((f) => {
      f.totals = { ...f.totals, net: -5 };
    });
    expect(ids(build({ ledger: negative }))).not.toContain(
      "incomeKeptCoversDays",
    );
  });

  it("leaves out the days kept covers under one day", () => {
    const ledger = withFlows((f) => {
      f.totals = { ...f.totals, net: 0.01 };
    });
    // floor(0.01 * 304 / 12) = 0
    expect(ids(build({ ledger }))).not.toContain("incomeKeptCoversDays");
  });

  it("makes no ratio when spending is zero", () => {
    const ledger = withFlows((f) => {
      f.totals = { ...f.totals, expenses: 0 };
    });
    expect(
      ids(build({ ledger })).filter(
        (id) => id !== "spendingPayeeInCategoryMonths",
      ),
    ).toEqual([]);
  });

  describe("the portfolio comparison", () => {
    const portfolio = (over: Record<string, unknown>) =>
      ({ ...fullEquivalenceInput().portfolio, ...over }) as never;

    it.each([
      ["no portfolio", null],
      ["an incomplete valuation", portfolio({ valuationComplete: false })],
      ["a loss", portfolio({ totalGainLoss: -100 })],
      ["no gain", portfolio({ totalGainLoss: 0 })],
      ["no cost basis", portfolio({ gainCostBasis: 0 })],
      // 1 / (12 / 3) = 0.25 months
      ["a result under half a month", portfolio({ totalGainLoss: 1 })],
    ])("is left out for %s", (_name, value) => {
      const facts = build({ portfolio: value });
      expect(ids(facts)).not.toContain("investmentsGainInMonthsOfSpending");
      expect(ids(facts)).toContain("spendingDailyAverage");
    });

    it("reads an absent completeness flag as no information, so the fact stays", () => {
      const facts = build({
        portfolio: portfolio({ valuationComplete: undefined }),
      });
      expect(ids(facts)).toContain("investmentsGainInMonthsOfSpending");
    });
  });
});
