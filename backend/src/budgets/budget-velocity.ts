import { daysBetween } from "../common/time-series/price-boundary.util";
import { FxAggregate } from "../common/fx-aggregate";
import { roundMoney } from "../common/round.util";

export function budgetPaceWindow(start: string, end: string, today: string) {
  const totalDays = daysBetween(start, end) + 1;
  const daysElapsed = Math.max(
    1,
    Math.min(totalDays, daysBetween(start, today) + 1),
  );
  return { totalDays, daysElapsed, daysRemaining: totalDays - daysElapsed };
}

export interface BudgetPaceInput {
  purchases: FxAggregate;
  spent: FxAggregate;
}

/** Already received refunds are in spent. Only purchases establish a future pace. */
export function projectBudgetSpending(
  inputs: Iterable<BudgetPaceInput>,
  elapsed: number,
  remaining: number,
) {
  const spent = new FxAggregate();
  const purchases = new FxAggregate();
  for (const line of inputs) {
    spent.merge(line.spent);
    purchases.merge(line.purchases);
  }
  const rate = purchases.isComplete
    ? purchases.unroundedSubtotal / elapsed
    : null;
  const remainingPurchases =
    remaining === 0 ? 0 : rate === null ? null : rate * remaining;
  return {
    currentSpent: spent.knownSubtotal,
    missingRatePairs: [
      ...new Set([...spent.missingPairs, ...purchases.missingPairs]),
    ].sort(),
    dailyBurnRate: rate === null ? null : roundMoney(rate),
    projectedTotal:
      spent.isComplete && remainingPurchases !== null
        ? roundMoney(spent.unroundedSubtotal + remainingPurchases)
        : null,
  };
}
