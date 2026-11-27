import { monthWithinDateRange } from '@/lib/calendar-month';
import { transactionsApi, type TransactionsRegisterFilterParams } from '@/lib/transactions';

/** The register's filters, without the date range and the order this sets itself. */
export type RegisterMonthFilters = Omit<
  TransactionsRegisterFilterParams,
  'startDate' | 'endDate' | 'sortBy' | 'sortDirection'
>;

/**
 * The id of the first row, oldest first, the register lists in `month` under
 * its filters and inside its date range `startDate`..`endDate`, or `null` when
 * it lists none there (issue #2475).
 *
 * This is the row the switch from the calendar back to the table lands on:
 * the page then asks the server for that row's page (`targetTransactionId`),
 * so the register opens where the month begins and no date filter is written.
 * The order is the register's own (`applyRegisterOrder` on the server), read
 * ascending, so ties on a day are broken exactly as the list breaks them.
 */
export async function firstRegisterRowInMonth(
  filters: RegisterMonthFilters,
  month: string,
  startDate: string,
  endDate: string,
): Promise<string | null> {
  const days = monthWithinDateRange(month, startDate, endDate);
  if (days === null) return null;
  const response = await transactionsApi.getAll({
    ...filters,
    ...days,
    sortBy: 'date',
    sortDirection: 'asc',
    page: 1,
    limit: 1,
  });
  return response.data[0]?.id ?? null;
}
