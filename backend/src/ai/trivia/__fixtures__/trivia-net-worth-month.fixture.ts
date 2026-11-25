import { FxAggregate } from "../../../common/fx-aggregate";
import type { TriviaNetWorthMonth } from "../trivia-facts";

/**
 * A month of the net worth series as `getMonthlyNetWorthWithAggregates`
 * returns it: `netWorth` read from an aggregate holding exactly that value,
 * or `exact` where a test needs the unrounded figure to differ from it.
 */
export function triviaNetWorthMonth(
  month: string,
  netWorth: number,
  over: Partial<Omit<TriviaNetWorthMonth, "netWorthAggregate">> & {
    exact?: number;
  } = {},
): TriviaNetWorthMonth {
  const { exact, ...rest } = over;
  const netWorthAggregate = new FxAggregate();
  netWorthAggregate.addConverted(exact ?? netWorth);
  return {
    month,
    netWorth,
    assets: netWorth,
    fxComplete: true,
    netWorthAggregate,
    ...rest,
  };
}
