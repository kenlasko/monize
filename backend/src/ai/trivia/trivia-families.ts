import type { TriviaFactId } from "./trivia.types";

/**
 * How often a family may be shown: `daily` facts move with each day, `event`
 * facts belong to a calendar moment, `evergreen` facts rotate.
 */
export type TriviaLane = "daily" | "event" | "evergreen";

/**
 * A family is a set of fact ids that say the same thing in alternative forms.
 * A day's list holds at most one fact per family, and a figure name belongs to
 * exactly one family, so the flat `figures` map never collides.
 */
export const TRIVIA_FAMILIES = {
  netWorthSinceStart: {
    lane: "evergreen",
    ids: ["netWorthSinceStart"],
  },
  netWorthBiggestJump: {
    lane: "evergreen",
    ids: ["netWorthBiggestJump"],
  },
  netWorthHighPoint: {
    lane: "evergreen",
    ids: ["netWorthHighPoint", "netWorthAtHighPoint"],
  },
  netWorthBiggestDip: {
    lane: "evergreen",
    ids: ["netWorthBiggestDip", "netWorthBiggestDipRecovered"],
  },
  netWorthLargestAsset: {
    lane: "evergreen",
    ids: ["netWorthLargestAsset"],
  },
  investmentsShareOfAssets: {
    lane: "evergreen",
    ids: ["investmentsShareOfAssets"],
  },
  investmentsGain: {
    lane: "evergreen",
    ids: ["investmentsGain", "investmentsLoss"],
  },
  investmentsCagr: {
    lane: "evergreen",
    ids: ["investmentsCagr"],
  },
  investmentsBiggestHolding: {
    lane: "evergreen",
    ids: ["investmentsBiggestHolding"],
  },
  investmentsBestPerformer: {
    lane: "evergreen",
    ids: ["investmentsBestPerformer"],
  },
  investmentsForeignAccount: {
    lane: "evergreen",
    ids: ["investmentsForeignAccount"],
  },
  investmentsLargestAccount: {
    lane: "evergreen",
    ids: ["investmentsLargestAccount"],
  },
  spendingTopCategory: {
    lane: "evergreen",
    ids: ["spendingTopCategory"],
  },
  spendingTopPayee: {
    lane: "evergreen",
    ids: ["spendingTopPayee"],
  },
  spendingBiggestMonth: {
    lane: "evergreen",
    ids: ["spendingBiggestMonth"],
  },
  incomeKeptShare: {
    lane: "evergreen",
    ids: ["incomeKeptShare"],
  },
  incomeSurplusMonths: {
    lane: "evergreen",
    ids: ["incomeSurplusMonths"],
  },
  incomeTopSource: {
    lane: "evergreen",
    ids: ["incomeTopSource"],
  },
  activityTransactions: {
    lane: "evergreen",
    ids: ["activityTransactions"],
  },
  activityPayees: {
    lane: "evergreen",
    ids: ["activityPayees"],
  },
  activityScheduled: {
    lane: "evergreen",
    ids: ["activityScheduled"],
  },
  warrantiesCovered: {
    lane: "evergreen",
    ids: ["warrantiesCovered"],
  },
  warrantiesNextExpiry: {
    lane: "evergreen",
    ids: ["warrantiesNextExpiry"],
  },
} as const satisfies Record<
  string,
  { lane: TriviaLane; ids: readonly TriviaFactId[] }
>;

export type TriviaFamily = keyof typeof TRIVIA_FAMILIES;

const FAMILY_BY_ID: ReadonlyMap<TriviaFactId, TriviaFamily> = new Map(
  (Object.keys(TRIVIA_FAMILIES) as TriviaFamily[]).flatMap((family) =>
    (TRIVIA_FAMILIES[family].ids as readonly TriviaFactId[]).map(
      (id) => [id, family] as const,
    ),
  ),
);

/** The family a fact id belongs to. */
export function familyOf(id: TriviaFactId): TriviaFamily {
  const family = FAMILY_BY_ID.get(id);
  if (!family) throw new Error(`Trivia fact id ${id} is in no family`);
  return family;
}

export function laneOf(family: TriviaFamily): TriviaLane {
  return TRIVIA_FAMILIES[family].lane;
}
