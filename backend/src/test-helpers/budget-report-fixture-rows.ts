import type { BudgetPeriod } from "../budgets/entities/budget-period.entity";

/** Route existing presentation-test fixtures into native cash query rows.
 * PostgreSQL acceptance tests separately exercise recognition and source edits.
 * These rows are fixture inputs; no allocation or health calculation lives here.
 */
export async function budgetReportFixtureRows(
  calls: unknown[][],
  periods: Promise<Partial<BudgetPeriod>[]> | undefined,
  explicit?: { total?: string },
) {
  const params = Object.assign(
    {},
    ...calls
      .map((call) => call[1])
      .filter((value) => value && typeof value === "object"),
  );
  const categoryIds: string[] =
    params.categoryIds ?? (params.categoryId ? [params.categoryId] : []);
  if (!categoryIds.length) return [];
  if (explicit)
    return [{ categoryId: categoryIds[0], total: explicit.total ?? "0" }];
  const start = params.periodStart ?? params.start;
  const period = ((await periods) ?? []).find(
    (item) => item.periodStart === start,
  );
  if (!period) return [];
  if (period.periodCategories?.length)
    return period.periodCategories
      .filter(
        (item) => item.categoryId && categoryIds.includes(item.categoryId),
      )
      .map((item) => ({
        categoryId: item.categoryId!,
        total: String(
          Number(item.actualAmount ?? 0) *
            (item.budgetCategory?.isIncome ? 1 : -1),
        ),
      }));
  return period.actualExpenses === undefined
    ? []
    : [
        {
          categoryId: categoryIds[0],
          total: String(-Number(period.actualExpenses)),
        },
      ];
}
