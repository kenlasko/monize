import type { PortfolioSummary } from "../../../securities/portfolio.service";
import type { TriviaFactsInput } from "../trivia-facts";
import type { TriviaLedgerInput } from "../trivia-ledger-facts";

/**
 * Inputs that make each builder produce every id it can. Each phase that adds
 * a builder extends this file with its own full input. The ids that exclude
 * each other (gain/loss, dip/recovered, high point/at high point) come from
 * `alternateInputs()`.
 */

const netWorthMonth = (month: string, netWorth: number) => ({
  month,
  netWorth,
  assets: netWorth,
  fxComplete: true,
});

const holding = (over: Record<string, unknown>) => ({
  id: "h",
  accountId: "a1",
  securityId: "s1",
  symbol: "XGRO",
  name: "XGRO",
  securityType: "ETF",
  currencyCode: "CAD",
  quantity: 1,
  averageCost: 1,
  costBasis: 100,
  costBasisAccountCurrency: 100,
  currentPrice: 1,
  marketValue: 150,
  marketValueAccountCurrency: 150,
  marketValueDefaultCurrency: 150,
  gainLoss: 50,
  gainLossPercent: 50,
  ...over,
});

function portfolio(over: Partial<PortfolioSummary> = {}): PortfolioSummary {
  return {
    totalPortfolioValue: 300,
    totalHoldingsValue: 300,
    totalGainLoss: 100,
    totalGainLossPercent: 50,
    gainCostBasis: 200,
    cagr: 7.55,
    valuationComplete: true,
    holdings: [],
    holdingsByAccount: [
      {
        accountId: "a1",
        accountName: "RRSP - Brokerage",
        currencyCode: "CAD",
        holdings: [holding({})],
      },
      {
        accountId: "a2",
        accountName: "US - Brokerage",
        currencyCode: "USD",
        holdings: [
          holding({
            id: "h2",
            accountId: "a2",
            securityId: "s2",
            symbol: "VTI",
            currencyCode: "USD",
            costBasis: 10,
            marketValue: 40,
            marketValueAccountCurrency: 40,
            marketValueDefaultCurrency: 56,
          }),
        ],
      },
    ],
    ...over,
  } as unknown as PortfolioSummary;
}

/** Net worth, investments and other-asset facts: the gain, dip and high-point variants. */
export function fullTriviaFactsInput(): TriviaFactsInput {
  return {
    currency: "CAD",
    months: [
      netWorthMonth("2024-11-01", 100),
      netWorthMonth("2024-12-01", 150),
      netWorthMonth("2025-01-01", 160),
      netWorthMonth("2025-02-01", 200),
      netWorthMonth("2025-03-01", 190),
      netWorthMonth("2025-04-01", 195),
      netWorthMonth("2025-05-01", 196),
      netWorthMonth("2025-06-01", 197),
      netWorthMonth("2025-07-01", 198),
      netWorthMonth("2025-08-01", 199),
      netWorthMonth("2025-09-01", 199),
      netWorthMonth("2025-10-01", 199),
      netWorthMonth("2025-11-01", 199),
      netWorthMonth("2025-12-01", 180),
    ],
    portfolio: portfolio(),
    otherAssets: [{ name: "House", value: 50 }],
    portfolioInNetWorth: true,
  };
}

/** The other variant of each exclusive pair: loss, at the high point, recovered dip. */
export function alternateInputs(): TriviaFactsInput[] {
  return [
    {
      ...fullTriviaFactsInput(),
      months: [
        netWorthMonth("2025-01-01", 200),
        netWorthMonth("2025-02-01", 100),
        netWorthMonth("2025-03-01", 200),
      ],
      portfolio: portfolio({ totalGainLoss: -100, totalGainLossPercent: -33 }),
    },
  ];
}

/** The twelve-month ledger: every id `buildLedgerTriviaFacts` can produce. */
export function fullLedgerInput(): TriviaLedgerInput {
  return {
    currency: "CAD",
    spendingByCategory: {
      data: [{ categoryId: "c", categoryName: "C", color: null, total: 5 }],
      totalSpending: 5,
      knownSpending: 5,
      currency: "CAD",
      missingCurrencies: [],
      excludedCount: 0,
    },
    spendingByPayee: {
      data: [{ payeeId: "p", payeeName: "P", total: 5 }],
      totalSpending: 5,
      knownSpending: 5,
      currency: "CAD",
      missingCurrencies: [],
      excludedCount: 0,
    },
    incomeVsExpenses: {
      data: ["2026-01", "2026-02", "2026-03"].map((period) => ({
        period,
        periodStart: `${period}-01`,
        periodEnd: `${period}-28`,
        income: 10,
        expenses: 4,
        net: 6,
      })),
      totals: {
        income: 30,
        expenses: 12,
        net: 18,
        knownIncome: 30,
        knownExpenses: 12,
        knownNet: 18,
      },
      currency: "CAD",
      missingCurrencies: [],
      excludedCount: 0,
    },
    incomeBySource: {
      data: [{ categoryId: "s", categoryName: "S", color: null, total: 30 }],
      totalIncome: 30,
      knownIncome: 30,
      currency: "CAD",
      missingCurrencies: [],
      excludedCount: 0,
    },
    records: {
      transactions: 2,
      firstTransactionDate: "2020-01-01",
      activePayees: 1,
      categories: 1,
      activeScheduled: 1,
    },
    warranties: {
      covered: 1,
      nextExpiring: { name: "W", expiresOn: "2027-01-01" },
    },
  };
}
