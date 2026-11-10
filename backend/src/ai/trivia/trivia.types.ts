export const TRIVIA_TOPICS = ["netWorth", "investments"] as const;
export type TriviaTopic = (typeof TRIVIA_TOPICS)[number];

/** One figure a sentence can quote, typed so the reader's browser can format it. */
export type TriviaFigure =
  | { kind: "money"; value: number; currency: string }
  | { kind: "percent"; value: number }
  | { kind: "multiple"; value: number }
  | { kind: "rate"; value: number }
  /** `YYYY-MM`. */
  | { kind: "month"; value: string }
  | { kind: "text"; value: string };

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
] as const;
export type TriviaFactId = (typeof TRIVIA_FACT_IDS)[number];

export interface TriviaFact {
  id: TriviaFactId;
  topic: TriviaTopic;
  figures: TriviaFigures;
}

/**
 * One sentence of the list. A calculated one is the catalog's message for
 * `factId`; a model's is `text`, with figures as `{name}` placeholders.
 */
export type TriviaItem =
  | { topic: TriviaTopic; source: "calculated"; factId: TriviaFactId }
  | { topic: TriviaTopic; source: "ai"; text: string };

export interface DashboardTriviaResponse {
  items: TriviaItem[];
  figures: TriviaFigures;
  generatedAt: string;
}
