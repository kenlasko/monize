import { useMemo } from 'react';
import { useReportData } from '@/hooks/useReportData';
import { createLogger } from '@/lib/logger';
import { transactionsApi, type TransactionsGetAllParams } from '@/lib/transactions';
import { investmentsApi } from '@/lib/investments';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { rowDate } from '@/lib/calendar-rows';
import type { Transaction } from '@/types/transaction';
import type { ScheduledOccurrence } from '@/types/scheduled-transaction';
import type { InvestmentTransaction } from '@/types/investment';

/**
 * How many rows a month's grid will draw before it withholds the layer.
 *
 * A grid is forty-two cells; past this the chips are a wall the reader cannot
 * read, and the honest answer is to say so and point at the filters rather
 * than to draw a thousand of them and let the browser decide which survive.
 */
export const CALENDAR_MAX_ROWS = 1000;

/**
 * How many occurrences of one schedule the calendar asks for.
 *
 * Sent explicitly rather than left to the endpoint's own default, so the
 * number the request used and the number the truncation check below compares
 * against are one constant rather than two that can drift apart.
 */
export const CALENDAR_MAX_PER_SCHEDULE = 100;

const logger = createLogger('Calendar');

/**
 * What the calendar asks the register for, minus the dates and the page.
 *
 * The month is the date filter in calendar mode, so `startDate`, `endDate`,
 * `page` and `limit` are the hook's to set; everything else is the page's own
 * filter panel, applied by the server exactly as it is for the table.
 */
export type CalendarRowFilters = Omit<
  TransactionsGetAllParams,
  'startDate' | 'endDate' | 'page' | 'limit' | 'targetTransactionId'
>;

export interface CalendarMonthPayload {
  transactions: Transaction[];
  /**
   * Every occurrence the server placed inside the grid, before the account
   * scope is applied -- that step needs the schedules, which are reference
   * data rather than part of this request.
   */
  occurrences: ScheduledOccurrence[];
  /** More rows than the grid will draw; the layer is withheld, not truncated. */
  withheld: boolean;
  rowCount: number;
  /**
   * The occurrence request failed and this month's scheduled items are missing.
   *
   * Separate from the hook's own `error`, which means the month itself could
   * not be loaded: the register's rows are the calendar's substance and they
   * arrived, so a scheduled half that did not is a named gap in a month that
   * still draws, never a blank page. The occurrence endpoint refuses a
   * `through` more than five years ahead, so the toolbar's own next-month
   * button reaches this.
   */
  occurrencesUnavailable: boolean;
  /** The per-schedule cap cut a schedule short of the grid's last day. */
  occurrencesTruncated: boolean;
}

/**
 * Whether the per-schedule cap cut any schedule short of the grid.
 *
 * The cap is applied per schedule after ordering by due date, and it counts
 * from each schedule's next occurrence rather than from the month on screen:
 * a daily schedule runs out roughly `CALENDAR_MAX_PER_SCHEDULE` days out, so
 * a month past that would draw nothing for it and say nothing about why. A
 * schedule that came back at the cap whose last occurrence falls before the
 * grid ends has more that the grid cannot see.
 *
 * A schedule that genuinely ended on its cap-th occurrence reads the same way
 * and is reported needlessly. That is the direction to be wrong in: a caption
 * nobody needed costs less than a bill nobody was shown.
 */
function occurrencesTruncated(
  all: readonly ScheduledOccurrence[],
  gridEnd: string,
): boolean {
  const perSchedule = new Map<string, { count: number; last: string }>();

  for (const occurrence of all) {
    const day = rowDate(occurrence.dueDate);
    const seen = perSchedule.get(occurrence.scheduledTransactionId);
    if (seen) {
      seen.count += 1;
      if (day > seen.last) seen.last = day;
    } else {
      perSchedule.set(occurrence.scheduledTransactionId, { count: 1, last: day });
    }
  }

  for (const { count, last } of perSchedule.values()) {
    if (count >= CALENDAR_MAX_PER_SCHEDULE && last < gridEnd) return true;
  }
  return false;
}

/**
 * The month's scheduled occurrences, or an honest account of why not.
 *
 * The occurrence half is caught here rather than left to reject the pair: a
 * failed lookup is not an empty one, but it is also not a reason to withhold
 * the register rows that did arrive.
 */
async function loadOccurrences(
  startDate: string,
  endDate: string,
): Promise<{
  occurrences: ScheduledOccurrence[];
  occurrencesUnavailable: boolean;
  occurrencesTruncated: boolean;
}> {
  try {
    // The endpoint has no lower bound, so it answers from each schedule's next
    // due date -- which is how an overdue occurrence still arrives. The grid's
    // own start is applied here.
    const all = await scheduledTransactionsApi.getOccurrences({
      through: endDate,
      maxPerSchedule: CALENDAR_MAX_PER_SCHEDULE,
    });

    return {
      occurrences: all.filter((o) => rowDate(o.dueDate) >= startDate),
      occurrencesUnavailable: false,
      occurrencesTruncated: occurrencesTruncated(all, endDate),
    };
  } catch (error) {
    logger.warn('Scheduled occurrences unavailable for this calendar month', error);
    return { occurrences: [], occurrencesUnavailable: true, occurrencesTruncated: false };
  }
}

/**
 * The identity of one calendar request: the grid's range and every filter that
 * changes which rows answer it.
 *
 * Built in one expression so the key a caller compares against `dataKey` and
 * the key the fetch was started for cannot drift apart. Undefined and empty
 * filters are dropped rather than stringified, so opening the panel and
 * closing it again does not read as a different question.
 */
export function calendarRequestKey(
  startDate: string,
  endDate: string,
  filters: CalendarRowFilters,
): string {
  const meaningful = Object.entries(filters)
    .filter(([, value]) =>
      Array.isArray(value) ? value.length > 0 : value !== undefined && value !== '',
    )
    .map(([key, value]) => [key, Array.isArray(value) ? [...value].sort() : value])
    .sort(([a], [b]) => String(a).localeCompare(String(b)));

  return JSON.stringify([startDate, endDate, meaningful]);
}

/**
 * The rows and scheduled occurrences that fall inside one month's grid.
 *
 * Both halves come from the server: the register's own endpoint under the
 * page's filters, and `GET /scheduled-transactions/occurrences`, which prices
 * each occurrence at what it would post today. The client expands no
 * recurrence and sums nothing (design I1, INV-OCCURRENCE-003).
 *
 * Built on `useReportData`, so the payload carries the `dataKey` it belongs to
 * and a failed load stays a failure rather than becoming an empty month.
 */
export function useCalendarMonthData(
  startDate: string,
  endDate: string,
  filters: CalendarRowFilters,
  /**
   * Bumped by the page after a write. A freshness signal, not part of the
   * request key: the same question asked again, not a different one.
   */
  refreshKey: number = 0,
) {
  const requestKey = calendarRequestKey(startDate, endDate, filters);

  const result = useReportData<CalendarMonthPayload>(
    async () => {
      const [transactions, scheduled] = await Promise.all([
        transactionsApi.getAllPages({ ...filters, startDate, endDate }),
        filters.basis === 'accrual' ? Promise.resolve({occurrences: [], occurrencesUnavailable:false, occurrencesTruncated:false}) : loadOccurrences(startDate, endDate),
      ]);

      return {
        transactions,
        ...scheduled,
        withheld: transactions.length > CALENDAR_MAX_ROWS,
        rowCount: transactions.length,
      };
    },
    [requestKey, refreshKey],
    { requestKey },
  );

  /**
   * Whether what is on screen answers the question currently being asked.
   *
   * A month that is still loading may keep the previous one visible, but it
   * must not be actionable: `docs/frontend/api-and-cache.md`, "stale data may
   * stay on screen; it may not stay actionable".
   */
  const isStale = result.data !== null && result.dataKey !== requestKey;

  return useMemo(
    () => ({ ...result, requestKey, isStale }),
    [result, requestKey, isStale],
  );
}

/**
 * What the Investments calendar's Transactions layer draws for one month.
 *
 * Two registers, one grid: the brokerage rows and the cash sleeve's rows. The
 * legs are reconciled by `dedupeInvestmentLegs` at the view, which is where the
 * scope that decides "is the trade on screen" lives.
 */
export interface InvestmentCalendarMonthPayload {
  brokerage: InvestmentTransaction[];
  cash: Transaction[];
  /** More rows than the grid will draw; the layer is withheld, not truncated. */
  withheld: boolean;
  rowCount: number;
}

/**
 * The identity of one investment-calendar request: the range and both scopes.
 *
 * The cash scope is derived from the brokerage selection rather than chosen, so
 * it cannot change on its own -- but it is part of the key anyway, because the
 * accounts list arriving is what turns an empty derived scope into a real one,
 * and the payload before and after that are answers to different questions.
 */
export function investmentCalendarRequestKey(
  startDate: string,
  endDate: string,
  brokerageAccountIds: readonly string[],
  cashAccountIds: readonly string[],
): string {
  return JSON.stringify([
    startDate,
    endDate,
    [...brokerageAccountIds].sort(),
    [...cashAccountIds].sort(),
  ]);
}

export function useInvestmentCalendarMonthData(
  startDate: string,
  endDate: string,
  brokerageAccountIds: readonly string[],
  cashAccountIds: readonly string[],
  refreshKey: number = 0,
) {
  const requestKey = investmentCalendarRequestKey(
    startDate,
    endDate,
    brokerageAccountIds,
    cashAccountIds,
  );

  const result = useReportData<InvestmentCalendarMonthPayload>(
    async () => {
      const [brokerage, cash] = await Promise.all([
        investmentsApi.getAllTransactionPages({
          // No ids means every investment account, which is what an empty
          // selection means on this page.
          accountIds:
            brokerageAccountIds.length > 0 ? [...brokerageAccountIds].join(',') : undefined,
          startDate,
          endDate,
        }),
        // An empty cash scope is a page with no linked sleeves, not "every
        // account": asking the register for no ids would answer with the whole
        // ledger, which is not this page's.
        cashAccountIds.length > 0
          ? transactionsApi.getAllPages({
              accountIds: [...cashAccountIds],
              startDate,
              endDate,
            })
          : Promise.resolve<Transaction[]>([]),
      ]);

      const rowCount = brokerage.length + cash.length;
      return { brokerage, cash, rowCount, withheld: rowCount > CALENDAR_MAX_ROWS };
    },
    [requestKey, refreshKey],
    { requestKey },
  );

  const isStale = result.data !== null && result.dataKey !== requestKey;

  return useMemo(
    () => ({ ...result, requestKey, isStale }),
    [result, requestKey, isStale],
  );
}
