import { CategorySpending } from "../budgets/budget-spending.util";

/**
 * A `queryCategorySpendingBuckets` double for a month-bucketed caller: one
 * bucket per calendar month of the requested range, keyed `YYYY-MM`, each
 * answered by `perMonth(monthKey)`.
 */
export const monthBuckets =
  (perMonth: (monthKey: string) => CategorySpending) =>
  async (...args: unknown[]) => {
    const start = args[4] as string;
    const end = args[5] as string;
    const buckets = new Map<string, CategorySpending>();
    let year = Number(start.slice(0, 4));
    let month = Number(start.slice(5, 7));
    for (;;) {
      const key = `${year}-${String(month).padStart(2, "0")}`;
      if (key > end.slice(0, 7)) break;
      buckets.set(key, perMonth(key));
      month += 1;
      if (month > 12) {
        month = 1;
        year += 1;
      }
    }
    return { currency: "USD", buckets };
  };
