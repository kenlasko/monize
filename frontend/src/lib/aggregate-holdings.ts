import { HoldingWithMarketValue } from '@/types/investment';
import { MONEY_SCALE, moneyDecimalsForCurrency, sumMoney } from '@/lib/format';

export interface AggregatedHolding extends HoldingWithMarketValue {
  /** Per-account breakdown for this security across the filtered account set. */
  accountBreakdowns: HoldingWithMarketValue[];
}

/**
 * Group holdings by security, summing quantities, cost basis and market values
 * across accounts. Average cost is recomputed from the aggregated totals so
 * cross-account rollups remain self-consistent. All input holdings for a given
 * security are assumed to share the same security currency (backend invariant).
 *
 * The aggregated row exposes `accountBreakdowns` so callers can render a
 * per-account drill-down without re-fetching.
 *
 * Money is added exactly at the currency's money precision (`sumMoney`), the
 * precision the server sends a holding's figures at, so the rollup is the
 * exact sum of the accounts' figures rather than a float one: 1.0007 and
 * 1.0143 add to 2.0149999999999997 in doubles, which reads $2.01, where their
 * sum, 2.015, reads $2.02 (`docs/specs/report-rounding-and-aggregation.md`
 * rule 4). The gain is then the single difference of the two sums.
 */
export function aggregateHoldingsBySecurity(
  holdings: HoldingWithMarketValue[],
): AggregatedHolding[] {
  const map = new Map<string, AggregatedHolding>();

  for (const h of holdings) {
    const existing = map.get(h.securityId);
    if (!existing) {
      map.set(h.securityId, { ...h, accountBreakdowns: [h] });
      continue;
    }

    const decimals = moneyDecimalsForCurrency(h.currencyCode);
    const add = (a: number, b: number) => sumMoney([a, b], decimals);
    const totalQuantity = Number(existing.quantity) + Number(h.quantity);
    const totalCostBasis = add(Number(existing.costBasis), Number(h.costBasis));
    // A sum with an unknown component is unknown: `Number(null)` is 0, which
    // silently dropped a whole account's basis from the rollup and overstated
    // the gain computed against it.
    const totalCostBasisAccountCurrency =
      existing.costBasisAccountCurrency === null ||
      h.costBasisAccountCurrency === null
        ? null
        : // In the account's currency, which the row does not name: added at
          // the column scale, which holds any currency's money exactly.
          sumMoney([existing.costBasisAccountCurrency, h.costBasisAccountCurrency], MONEY_SCALE);
    const existingMv = existing.marketValue;
    const addMv = h.marketValue;
    // Same rule for market value: one unpriced account makes the security's
    // aggregate value unknown, not the priced accounts' subtotal.
    const totalMarketValue =
      existingMv === null || addMv === null ? null : add(existingMv, addMv);
    const gainLoss =
      totalMarketValue !== null ? add(totalMarketValue, -totalCostBasis) : null;
    const gainLossPercent =
      gainLoss !== null && totalCostBasis > 0
        ? (gainLoss / totalCostBasis) * 100
        : null;
    const averageCost = totalQuantity > 0 ? totalCostBasis / totalQuantity : 0;

    map.set(h.securityId, {
      ...existing,
      quantity: totalQuantity,
      averageCost,
      costBasis: totalCostBasis,
      costBasisAccountCurrency: totalCostBasisAccountCurrency,
      marketValue: totalMarketValue,
      gainLoss,
      gainLossPercent,
      accountBreakdowns: [...existing.accountBreakdowns, h],
    });
  }

  return Array.from(map.values());
}
