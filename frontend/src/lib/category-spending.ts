import type { CategorySpendingItem, SpendingByCategoryResponse } from '@/types/built-in-reports';

/** An absent share in a signed response is intentional (for example, a net refund). */
export function categorySpendingShare(
  item: CategorySpendingItem,
  response: SpendingByCategoryResponse,
): number | undefined {
  if (response.netSpending) return item.percentage;
  // Older servers return only the monetary figures. Preserve their share of the known subtotal.
  return response.knownSpending > 0 ? (item.total / response.knownSpending) * 100 : 0;
}
