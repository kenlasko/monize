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
    ids: ["spendingTopCategory", "spendingTopCategoryWindow"],
  },
  spendingTopPayee: {
    lane: "evergreen",
    ids: ["spendingTopPayee", "spendingTopPayeeWindow"],
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
    ids: ["incomeTopSource", "incomeTopSourceWindow"],
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
  spendingMonthToDate: {
    lane: "daily",
    ids: ["spendingMonthToDateLess", "spendingMonthToDateMore"],
  },
  spendingLastDay: {
    lane: "daily",
    ids: ["spendingLastDay"],
  },
  spendingLastSevenDays: {
    lane: "daily",
    ids: ["spendingLastSevenDays"],
  },
  spendingBiggestRecentPurchase: {
    lane: "daily",
    ids: ["spendingBiggestRecentPurchase"],
  },
  spendingNoSpendStreak: {
    lane: "daily",
    ids: ["spendingNoSpendStreak"],
  },
  spendingDaysSincePayee: {
    lane: "daily",
    ids: ["spendingDaysSincePayee"],
  },
  activityBillsDueThisWeek: {
    lane: "daily",
    ids: ["activityBillsDueThisWeek"],
  },
  activityNextBill: {
    lane: "daily",
    ids: ["activityNextBill"],
  },
  spendingBudgetPace: {
    lane: "daily",
    ids: ["spendingBudgetPace"],
  },
  investmentsTopMover: {
    lane: "daily",
    ids: ["investmentsTopMoverUp", "investmentsTopMoverDown"],
  },
  activityAnniversary: {
    lane: "event",
    ids: ["activityAnniversary"],
  },
  activityAccountAnniversary: {
    lane: "event",
    ids: ["activityAccountAnniversary"],
  },
  netWorthMilestone: {
    lane: "event",
    ids: ["netWorthMilestone"],
  },
  activityTransactionMilestone: {
    lane: "event",
    ids: ["activityTransactionMilestone"],
  },
  warrantiesExpiresSoon: {
    lane: "event",
    ids: ["warrantiesExpiresSoon"],
  },
  spendingYearAgoMonth: {
    lane: "evergreen",
    ids: ["spendingYearAgoMonth"],
  },
  netWorthYearAgo: {
    lane: "evergreen",
    ids: ["netWorthYearAgoUp", "netWorthYearAgoDown"],
  },
  spendingRankedCategory: {
    lane: "evergreen",
    ids: ["spendingRankedCategory"],
  },
  spendingRankedPayee: {
    lane: "evergreen",
    ids: ["spendingRankedPayee"],
  },
  incomeRankedSource: {
    lane: "evergreen",
    ids: ["incomeRankedSource"],
  },
  spendingPayeeInCategoryMonths: {
    lane: "evergreen",
    ids: ["spendingPayeeInCategoryMonths"],
  },
  spendingDailyAverage: {
    lane: "evergreen",
    ids: ["spendingDailyAverage"],
  },
  incomeKeptCoversDays: {
    lane: "evergreen",
    ids: ["incomeKeptCoversDays"],
  },
  investmentsGainInMonthsOfSpending: {
    lane: "evergreen",
    ids: ["investmentsGainInMonthsOfSpending"],
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
