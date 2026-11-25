import type { PortfolioSummary } from "../../../securities/portfolio.service";
import type { TriviaFactsInput } from "../trivia-facts";
import type { ResolvedScheduledOccurrence } from "../../../scheduled-transactions/scheduled-occurrence.service";
import type { TopMover } from "../../../securities/portfolio.service";
import type { TriviaCalendarInput } from "../trivia-calendar-facts";
import type { TriviaEquivalenceInput } from "../trivia-equivalence-facts";
import type { TriviaDailyInput } from "../trivia-daily-facts";
import type { TriviaLedgerInput } from "../trivia-ledger-facts";
import type { TriviaLedgerLoad } from "../trivia-ledger.loader";
import type { TriviaRankedInput } from "../trivia-ranked-facts";
import {
  WINDOWED_FAMILIES,
  emptyWindowedReads,
  type TriviaPicks,
} from "../trivia-windowed-reads";
import { TRIVIA_WINDOWS, type TriviaWindow } from "../trivia.types";
import { triviaNetWorthMonth } from "./trivia-net-worth-month.fixture";

/**
 * Inputs that make each builder produce every id it can. Each phase that adds
 * a builder extends this file with its own full input. The ids that exclude
 * each other (gain/loss, dip/recovered, high point/at high point) come from
 * `alternateInputs()`.
 */

const netWorthMonth = (month: string, netWorth: number) =>
  triviaNetWorthMonth(month, netWorth);

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
    places: 2,
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
      data: [
        {
          categoryId: "s",
          categoryName: "S",
          color: null,
          total: 30,
          percentage: 100,
        },
      ],
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

const rankedReports = () => ({
  spendingByCategory: {
    data: [
      { categoryId: "c1", categoryName: "Rent", color: null, total: 60 },
      { categoryId: "c2", categoryName: "Food", color: null, total: 30 },
      { categoryId: "c3", categoryName: "Fun", color: null, total: 10 },
    ],
    totalSpending: 100,
    knownSpending: 100,
    currency: "CAD",
    missingCurrencies: [],
    excludedCount: 0,
  },
  spendingByPayee: {
    data: [
      { payeeId: "p1", payeeName: "Landlord", total: 60 },
      { payeeId: "p2", payeeName: "Grocer", total: 30 },
      { payeeId: "p3", payeeName: "Cafe", total: 10 },
    ],
    totalSpending: 100,
    knownSpending: 100,
    currency: "CAD",
    missingCurrencies: [],
    excludedCount: 0,
  },
  incomeBySource: {
    data: [
      {
        categoryId: "s1",
        categoryName: "Salary",
        color: null,
        total: 80,
        percentage: 80,
      },
      {
        categoryId: "s2",
        categoryName: "Interest",
        color: null,
        total: 15,
        percentage: 15,
      },
      {
        categoryId: "s3",
        categoryName: "Gifts",
        color: null,
        total: 5,
        percentage: 5,
      },
    ],
    totalIncome: 100,
    knownIncome: 100,
    currency: "CAD",
    missingCurrencies: [],
    excludedCount: 0,
  },
});

/** Every windowed family picked the same window and rank, with three rows each. */
export function rankedInput(
  window: TriviaWindow,
  rank: 2 | 3 = 2,
): TriviaRankedInput {
  const reports = rankedReports();
  const windowed = emptyWindowedReads();
  if (window !== "m12") {
    windowed.spendingByCategory.set(window, reports.spendingByCategory);
    windowed.spendingByPayee.set(window, reports.spendingByPayee);
    windowed.incomeBySource.set(window, reports.incomeBySource);
  }
  return {
    currency: "CAD",
    picks: Object.fromEntries(
      WINDOWED_FAMILIES.map((family) => [family, { window, rank }]),
    ) as TriviaPicks,
    windowed,
    m12:
      window === "m12"
        ? reports
        : {
            spendingByCategory: null,
            spendingByPayee: null,
            incomeBySource: null,
          },
  };
}

/** The legacy ids (m12) and the six ranked ones. */
export const fullRankedInput = (): TriviaRankedInput => rankedInput("m12");
/** The `...Window` ids, over ninety days. */
export const alternateRankedInput = (): TriviaRankedInput => rankedInput("d90");

/**
 * What the ledger loader returns: the twelve-month reads and, for every other
 * window, three-row reports, so whatever window a pick lands on has data.
 */
export function fullLedgerLoad(): TriviaLedgerLoad {
  const windowed = emptyWindowedReads();
  for (const window of TRIVIA_WINDOWS.filter((w) => w !== "m12")) {
    const reports = rankedReports();
    windowed.spendingByCategory.set(window, reports.spendingByCategory);
    windowed.spendingByPayee.set(window, reports.spendingByPayee);
    windowed.incomeBySource.set(window, reports.incomeBySource);
  }
  return { ...fullLedgerInput(), windowed };
}

/** A resolved bill; only what the daily facts read is real. */
export function occurrence(
  over: Partial<ResolvedScheduledOccurrence> & {
    name?: string;
  } = {},
): ResolvedScheduledOccurrence {
  const { name, ...rest } = over;
  return {
    scheduledTransactionId: "s1",
    originalDate: "2026-11-21",
    dueDate: "2026-11-21",
    amount: -80,
    directionAmount: -80,
    currencyCode: "CAD",
    complete: true,
    estimated: false,
    schedule: { name: name ?? "Rent" },
    ...rest,
  } as unknown as ResolvedScheduledOccurrence;
}

function mover(over: Partial<TopMover> = {}): TopMover {
  return {
    securityId: "s1",
    symbol: "XGRO",
    name: "XGRO",
    currencyCode: "CAD",
    currentPrice: 102,
    previousPrice: 100,
    dailyChange: 2,
    dailyChangePercent: 2,
    priceDate: "2026-11-18",
    marketValue: 1020,
    dailyValueChange: 20,
    ...over,
  };
}

/** Today is 2026-11-19, so the last complete day is 2026-11-18. */
export function fullDailyInput(): TriviaDailyInput {
  return {
    currency: "CAD",
    today: "2026-11-19",
    monthToDate: { through: "2026-11-18", spent: 400, previousSpent: 500 },
    lastDay: { date: "2026-11-18", spent: 42.5 },
    lastSevenDays: { from: "2026-11-12", spent: 310 },
    biggestPurchase: {
      amount: 120,
      currency: "CAD",
      payee: "Grocer",
      date: "2026-11-15",
      singleCurrency: true,
    },
    lastSpendDate: "2026-11-15",
    // A sample of every id, not one coherent week: the loader only passes a
    // streak the report confirms, which `lastDay` would then contradict.
    streakSpent: 0,
    sincePayee: { name: "Cafe", lastDate: "2026-11-10" },
    bills: {
      occurrences: [occurrence(), occurrence({ dueDate: "2026-11-23" })],
      total: 160,
    },
    budget: {
      name: "Household",
      currency: "CAD",
      incomeLinked: false,
      lines: [
        { spent: 100, budgeted: 200 },
        { spent: 50, budgeted: 100 },
      ],
    },
    topMover: mover(),
  };
}

/** The other variant of each exclusive pair: more than last month, a down mover. */
export function alternateDailyInput(): TriviaDailyInput {
  return {
    ...fullDailyInput(),
    monthToDate: { through: "2026-11-18", spent: 600, previousSpent: 500 },
    topMover: mover({
      dailyChangePercent: -2,
      dailyChange: -2,
      dailyValueChange: -20,
    }),
  };
}

/**
 * Today is 2026-11-19. The ledger began 2023-11-17 (an anniversary in its
 * week), net worth crossed 1,000 in October and was 800 a year ago, the 1,000th
 * row was recorded this month, and a warranty runs out in 15 days.
 */
export function fullCalendarInput(): TriviaCalendarInput {
  return {
    today: "2026-11-19",
    currency: "CAD",
    places: 2,
    months: [
      netWorthMonth("2025-11-01", 800),
      netWorthMonth("2026-09-01", 950),
      netWorthMonth("2026-10-01", 990),
      netWorthMonth("2026-11-01", 1050),
    ].sort((a, b) => a.month.localeCompare(b.month)),
    records: {
      transactions: 1000,
      firstTransactionDate: "2023-11-17",
      activePayees: 1,
      categories: 1,
      activeScheduled: 1,
    },
    warranties: {
      covered: 1,
      nextExpiring: { name: "Laptop", expiresOn: "2026-12-04" },
    },
    calendar: {
      accountFirstDates: [
        { name: "Chequing", firstDate: "2021-11-15" },
        { name: "Savings", firstDate: "2024-03-01" },
      ],
      transactionsRecordedBefore: 990,
      yearAgoMonth: {
        data: [
          {
            categoryId: "c1",
            categoryName: "Groceries",
            color: null,
            total: 300,
          },
        ],
        totalSpending: 900,
        knownSpending: 900,
        currency: "CAD",
        missingCurrencies: [],
        excludedCount: 0,
      },
    },
  };
}

/** The other variant of the year-ago pair: net worth lower now than a year ago. */
export function alternateCalendarInput(): TriviaCalendarInput {
  const input = fullCalendarInput();
  return {
    ...input,
    months: input.months.map((m) =>
      m.month === "2025-11-01" ? triviaNetWorthMonth(m.month, 1200) : m,
    ),
  };
}

/**
 * Three months of flows (12 spent, 18 kept) over 2026-01-01 to 2026-10-31
 * (304 days), a 5 top category and payee, and a complete portfolio gaining
 * 100: every equivalence id.
 */
export function fullEquivalenceInput(): TriviaEquivalenceInput {
  return {
    today: "2026-11-19",
    currency: "CAD",
    ledger: fullLedgerInput(),
    portfolio: portfolio(),
  };
}
