export const TRIVIA_TOPICS = [
  "netWorth",
  "investments",
  "spending",
  "income",
  "activity",
  "warranties",
] as const;
export type TriviaTopic = (typeof TRIVIA_TOPICS)[number];

/** One figure a sentence can quote, typed so the reader's browser can format it. */
export type TriviaFigure =
  | { kind: "money"; value: number; currency: string }
  | { kind: "percent"; value: number }
  | { kind: "multiple"; value: number }
  | { kind: "rate"; value: number }
  /** A whole number of things: transactions, payees, months. */
  | { kind: "count"; value: number }
  /** `YYYY-MM`. */
  | { kind: "month"; value: string }
  | { kind: "text"; value: string }
  /** `YYYY-MM-DD`, shown as a full date. */
  | { kind: "date"; value: string }
  /** `YYYY-MM-DD`, a recent day shown with its weekday. */
  | { kind: "day"; value: string }
  /** A whole number of days, shown with its unit. */
  | { kind: "days"; value: number }
  /** A whole number of years, shown with its unit. */
  | { kind: "years"; value: number };

/** Every figure of the day's facts, by the unique name a sentence quotes it by. */
export type TriviaFigures = Record<string, TriviaFigure>;

export const TRIVIA_FACT_IDS = [
  "netWorthSinceStart",
  "netWorthBiggestJump",
  "netWorthHighPoint",
  "netWorthAtHighPoint",
  "netWorthBiggestDip",
  "netWorthBiggestDipRecovered",
  "netWorthLargestAsset",
  "investmentsShareOfAssets",
  "investmentsGain",
  "investmentsLoss",
  "investmentsCagr",
  "investmentsBiggestHolding",
  "investmentsBestPerformer",
  "investmentsForeignAccount",
  "investmentsLargestAccount",
  "spendingTopCategory",
  "spendingTopPayee",
  "spendingBiggestMonth",
  "incomeKeptShare",
  "incomeSurplusMonths",
  "incomeTopSource",
  "activityTransactions",
  "activityPayees",
  "activityScheduled",
  "warrantiesCovered",
  "warrantiesNextExpiry",
  "spendingMonthToDateLess",
  "spendingMonthToDateMore",
  "spendingLastDay",
  "spendingLastSevenDays",
  "spendingBiggestRecentPurchase",
  "spendingNoSpendStreak",
  "spendingDaysSincePayee",
  "activityBillsDueThisWeek",
  "activityNextBill",
  "spendingBudgetPace",
  "investmentsTopMoverUp",
  "investmentsTopMoverDown",
  "activityAnniversary",
  "activityAccountAnniversary",
  "netWorthMilestone",
  "activityTransactionMilestone",
  "warrantiesExpiresSoon",
  "spendingYearAgoMonth",
  "netWorthYearAgoUp",
  "netWorthYearAgoDown",
] as const;
export type TriviaFactId = (typeof TRIVIA_FACT_IDS)[number];

/** The span a windowed fact describes. */
export const TRIVIA_WINDOWS = ["d30", "d90", "ytd", "m12", "all"] as const;
export type TriviaWindow = (typeof TRIVIA_WINDOWS)[number];

export type TriviaFactParams = { window?: TriviaWindow };

export interface TriviaFact {
  id: TriviaFactId;
  topic: TriviaTopic;
  figures: TriviaFigures;
  params?: TriviaFactParams;
}

/**
 * One sentence of the list. A calculated one is the catalog's message for
 * `factId`; a model's is `text`, with figures as `{name}` placeholders.
 */
export type TriviaItem =
  | {
      topic: TriviaTopic;
      source: "calculated";
      factId: TriviaFactId;
      params?: TriviaFactParams;
    }
  | {
      topic: TriviaTopic;
      source: "ai";
      text: string;
      factIds?: TriviaFactId[];
    };

export interface DashboardTriviaResponse {
  items: TriviaItem[];
  figures: TriviaFigures;
  generatedAt: string;
}
