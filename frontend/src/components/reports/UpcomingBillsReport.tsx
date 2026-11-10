'use client';

import { useState, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { useRouter } from 'next/navigation';
import {
  format,
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  isSameMonth,
  isToday,
  addMonths,
  subMonths,
  getDay,
} from 'date-fns';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { parseLocalDate } from '@/lib/utils';
import {
  SCHEDULED_KIND_AMOUNT_CLASSES,
  SCHEDULED_KIND_CHIP_CLASSES,
  occurrenceKind,
} from '@/lib/scheduled-kind';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { ReportToolbarActions } from '@/components/reports/ReportToolbarActions';
import { exportToCsv } from '@/lib/csv-export';
import { useReportData } from '@/hooks/useReportData';
import { ReportError } from '@/components/reports/ReportError';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { sumEffectiveOccurrences } from '@/lib/scheduled-effective-amount';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { isComplete, type ConvertedTotal } from '@/lib/currency-total';
import { EmptyState } from '@/components/ui/EmptyState';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';

/** How far ahead the report projects, matching the three months it always has. */
const HORIZON_MONTHS = 3;

/**
 * Why a withheld total is withheld, which decides where the reader goes to fix
 * it: a named currency is a display rate to refresh on the Currencies page, an
 * unnamed shortfall is one occurrence's own settlement rate.
 */
function unknownReason(total: ConvertedTotal): 'displayFx' | 'scheduledFx' {
  return total.missingCurrencies.length > 0 ? 'displayFx' : 'scheduledFx';
}

interface CalendarDay {
  date: Date;
  isCurrentMonth: boolean;
  isToday: boolean;
  bills: UpcomingBill[];
}

interface UpcomingBill {
  scheduledTransaction: ScheduledTransaction;
  dueDate: Date;
  /**
   * What THIS occurrence would post today, from the server's occurrence contract;
   * `null` when it cannot be determined (issue #1247). Never the persisted
   * `amount`, and never the schedule-level figure applied to every projected
   * occurrence -- this report used to do the second, so an occurrence the user
   * had re-priced was listed, totalled and exported at the template's amount.
   */
  amount: number | null;
  /**
   * The currency `amount` is in -- the occurrence's own, which for an investment
   * schedule is the settlement currency rather than the brokerage account's.
   */
  currencyCode: string;
  /**
   * The signed amount that decides direction, `null` when the server could not
   * derive it. Carried so `occurrenceKind` reads the occurrence rather than
   * falling back to the schedule's snapshot sign.
   */
  directionAmount: number | null;
  /** The amount is the schedule's history estimate (issue #2096). */
  estimated: boolean;
  isOverdue: boolean;
}

export function UpcomingBillsReport() {
  const t = useTranslations('reports');
  const router = useRouter();
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const formatChartDate = useChartDateFormat();
  // Every occurrence is priced in its own currency, so a single total needs a
  // conversion rather than an addition (issue #1247).
  const { convertToDefault, defaultCurrency } = useExchangeRates();
  const [currentMonth, setCurrentMonth] = useState(new Date());
  const [viewType, setViewType] = useState<'calendar' | 'list'>('calendar');

  // The window is fixed for the life of the mount, so the request key is stable
  // across re-renders (the month arrows move the calendar, not the horizon).
  const [through] = useState(() =>
    format(addMonths(new Date(), HORIZON_MONTHS), 'yyyy-MM-dd'),
  );

  // Schedules for their names, kinds and accounts; occurrences for the dates and
  // the amounts. The browser cannot derive the second from the first: expanding
  // the recurrence here gives dates with no per-occurrence amount, which is how
  // one schedule-level figure came to be printed against every occurrence and
  // exported (issue #1247).
  const { data: response, isLoading, error, reload } = useReportData(
    async () => {
      const [schedules, occurrences] = await Promise.all([
        scheduledTransactionsApi.getAll(),
        // A failed occurrences read is "no information", not a failed report.
        // This endpoint is newer than the page, so during a rolling deploy the new
        // client can be served while a pod still runs the previous backend: a
        // rejected leg inside `Promise.all` took the whole report down, retry
        // button and all, for something the schedules leg could still describe.
        // `null` is distinguishable from `[]` -- an empty array means "no
        // occurrences", which is a real answer and must keep rendering as one.
        scheduledTransactionsApi
          .getOccurrences({ through })
          .catch(() => null),
      ]);
      return { schedules, occurrences };
    },
    [through],
  );

  /** The projection could not be loaded -- not the same as having none. */
  const occurrencesUnavailable = response != null && response.occurrences === null;

  // Every active schedule is reported, whatever its kind: a transfer between the
  // user's own accounts and a zero-amount reminder both have due dates, and
  // leaving them out made them vanish from the calendar (issue #1124). Their
  // amounts are kept out of the money totals below -- see `summary`.
  const scheduledTransactions = useMemo(
    () => (response?.schedules ?? []).filter((st) => st.isActive),
    [response],
  );

  const upcomingBills = useMemo((): UpcomingBill[] => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const byId = new Map(scheduledTransactions.map((st) => [st.id, st]));

    // The server orders by due date already; an occurrence whose schedule is not
    // in the active list is skipped rather than drawn without its name.
    return (response?.occurrences ?? []).flatMap((occurrence) => {
      const scheduledTransaction = byId.get(occurrence.scheduledTransactionId);
      if (!scheduledTransaction) return [];
      const dueDate = parseLocalDate(occurrence.dueDate);
      return [
        {
          scheduledTransaction,
          dueDate,
          amount: occurrence.amount,
          currencyCode: occurrence.currencyCode,
          directionAmount: occurrence.directionAmount,
          estimated: occurrence.estimated === true,
          isOverdue: dueDate < today,
        },
      ];
    });
  }, [response, scheduledTransactions]);

  const calendarDays = useMemo((): CalendarDay[] => {
    const monthStart = startOfMonth(currentMonth);
    const monthEnd = endOfMonth(currentMonth);

    // Get the start of the calendar (may include days from prev month)
    const calendarStart = new Date(monthStart);
    calendarStart.setDate(calendarStart.getDate() - getDay(monthStart));

    // Get end of calendar (may include days from next month)
    const calendarEnd = new Date(monthEnd);
    const daysToAdd = 6 - getDay(monthEnd);
    calendarEnd.setDate(calendarEnd.getDate() + daysToAdd);

    const days = eachDayOfInterval({ start: calendarStart, end: calendarEnd });

    // Build a map of occurrences by date, so the calendar and the list are the
    // same set of occurrences rather than two expansions that can disagree.
    const billsByDate = new Map<string, UpcomingBill[]>();
    upcomingBills.forEach((bill) => {
      const key = format(bill.dueDate, 'yyyy-MM-dd');
      billsByDate.set(key, [...(billsByDate.get(key) ?? []), bill]);
    });

    return days.map((date) => ({
      date,
      isCurrentMonth: isSameMonth(date, currentMonth),
      isToday: isToday(date),
      bills: billsByDate.get(format(date, 'yyyy-MM-dd')) || [],
    }));
  }, [currentMonth, upcomingBills]);

  const summary = useMemo(() => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const monthEnd = endOfMonth(currentMonth);

    const overdue = upcomingBills.filter((b) => b.isOverdue);
    const thisMonth = upcomingBills.filter(
      (b) => !b.isOverdue && b.dueDate <= monthEnd && isSameMonth(b.dueDate, currentMonth)
    );

    // A transfer moves money between the user's own accounts, so it is counted
    // as something coming up but never added to a money total -- summing it
    // beside bills and deposits would overstate both. An occurrence whose
    // current amount is unknown makes the total unknown rather than smaller
    // (issue #1247); the known part is kept separately and never shown under
    // the total's own caption.
    // With no projection, a total of zero would be a measured zero for a state
    // nobody measured. One excluded component makes `isComplete` false, so every
    // figure below renders as unavailable and the notice above says why.
    const totalOf = (bills: UpcomingBill[]): ConvertedTotal =>
      occurrencesUnavailable
        ? { value: 0, missingCurrencies: [], excludedCount: 1 }
        : sumEffectiveOccurrences(
            bills.filter((b) => !b.scheduledTransaction.isTransfer),
            (b) => ({
              amount: b.amount,
              currencyCode: b.currencyCode,
              complete: b.amount !== null,
            }),
            convertToDefault,
            Math.abs,
          );

    return {
      overdueCount: overdue.length,
      overdueTotal: totalOf(overdue),
      thisMonthCount: thisMonth.length,
      thisMonthTotal: totalOf(thisMonth),
    };
  }, [upcomingBills, currentMonth, convertToDefault, occurrencesUnavailable]);

  const handleBillClick = (_st: ScheduledTransaction) => {
    router.push('/bills');
  };

  const getExportData = () => {
    const headers = [
      t('upcomingBills.csvColBillName'),
      t('upcomingBills.csvColDueDate'),
      t('upcomingBills.csvColAmount'),
      // The amount column holds the occurrence's own figure, so the currency is
      // its own column rather than a fact the reader has to assume. A
      // spreadsheet that sums a CAD row into a USD column is the export's
      // version of the defect the totals above fix (issue #1247).
      t('upcomingBills.csvColCurrency'),
      t('upcomingBills.csvColFrequency'),
      t('upcomingBills.csvColAccount'),
      t('upcomingBills.csvColStatus'),
    ];
    const rows: (string | number)[][] = upcomingBills.map((bill) => [
      bill.scheduledTransaction.name,
      format(bill.dueDate, 'yyyy-MM-dd'),
      // An amount nobody can work out is exported as an explicit marker, not as
      // an empty cell (indistinguishable from zero once a spreadsheet totals the
      // column) and not as the stale stored figure (issue #1247).
      bill.amount ?? t('upcomingBills.csvAmountUnavailable'),
      bill.currencyCode,
      bill.scheduledTransaction.frequency,
      bill.scheduledTransaction.account?.name || '',
      bill.isOverdue ? t('upcomingBills.csvStatusOverdue') : bill.scheduledTransaction.autoPost ? t('upcomingBills.csvStatusAuto') : t('upcomingBills.csvStatusManual'),
    ]);
    return { headers, rows };
  };

  const handleExportCsv = () => {
    const { headers, rows } = getExportData();
    exportToCsv('upcoming-bills', headers, rows);
  };

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const { headers, rows } = getExportData();
    const pdfCards = [
      { label: t('upcomingBills.pdfActiveBills'), value: String(scheduledTransactions.length), color: '#111827' },
      ...(summary.overdueCount > 0 ? [{ label: t('upcomingBills.pdfOverdue'), value: String(summary.overdueCount), color: '#dc2626' }] : []),
      {
        label: t('upcomingBills.pdfThisMonth'),
        // The total is withheld when any occurrence in it is unknown or could
        // not be converted into the reporting currency -- a PDF is a record, so
        // a figure in it must not be a partial sum wearing a total's caption
        // (issue #1247). `isComplete` covers both causes; a figure printed here
        // is complete in `defaultCurrency` and says so.
        value: !isComplete(summary.thisMonthTotal)
          ? `${summary.thisMonthCount} (${t('upcomingBills.amountUnavailable')})`
          : `${summary.thisMonthCount} (${formatCurrency(summary.thisMonthTotal.value, defaultCurrency)})`,
        color: '#2563eb',
      },
    ];
    await exportToPdf({
      title: t('upcomingBills.pdfTitle'),
      subtitle: t('upcomingBills.pdfSubtitle', { month: formatChartDate(currentMonth, 'MMMM yyyy'), count: scheduledTransactions.length }),
      summaryCards: pdfCards,
      tableData: { headers, rows },
      filename: 'upcoming-bills',
    });
  };

  if (error) {
    return <ReportError onRetry={reload} />;
  }

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="space-y-4">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {occurrencesUnavailable && (
        <div
          className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200"
          data-testid="occurrences-unavailable"
          role="status"
        >
          <p>{t('upcomingBills.occurrencesUnavailable')}</p>
          <button
            type="button"
            onClick={reload}
            className="mt-2 inline-flex items-center rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
            data-testid="occurrences-retry"
          >
            {t('error.retry')}
          </button>
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
          <div className="text-sm text-gray-500 dark:text-gray-400">{t('upcomingBills.activeBills')}</div>
          <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {scheduledTransactions.length}
          </div>
        </div>
        {summary.overdueCount > 0 && (
          <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-4">
            <div className="text-sm text-red-600 dark:text-red-400">{t('upcomingBills.overdue')}</div>
            <div className="text-xl font-bold text-red-700 dark:text-red-300">
              {summary.overdueCount}
            </div>
            <div className="text-sm text-red-600 dark:text-red-400">
              {isComplete(summary.overdueTotal) ? (
                formatCurrency(summary.overdueTotal.value, defaultCurrency)
              ) : (
                <UnknownAmount reason={unknownReason(summary.overdueTotal)} />
              )}
            </div>
          </div>
        )}
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4">
          <div className="text-sm text-blue-600 dark:text-blue-400">{t('upcomingBills.thisMonth')}</div>
          <div className="text-xl font-bold text-blue-700 dark:text-blue-300">
            {summary.thisMonthCount}
          </div>
          <div className="text-sm text-blue-600 dark:text-blue-400">
            {isComplete(summary.thisMonthTotal) ? (
              formatCurrency(summary.thisMonthTotal.value, defaultCurrency)
            ) : (
              <UnknownAmount reason={unknownReason(summary.thisMonthTotal)} />
            )}
          </div>
        </div>
      </div>

      {/* Controls */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        {/* The month stepper alone fills a phone, so the view switch and the
            export take a line of their own below it rather than being pushed
            off the right of the card. One row from `sm` up. */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCurrentMonth(subMonths(currentMonth, 1))}
              className="p-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              <svg className="h-5 w-5 text-gray-600 dark:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 min-w-[160px] text-center">
              {formatChartDate(currentMonth, 'MMMM yyyy')}
            </h3>
            <button
              onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
              className="p-2 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              <svg className="h-5 w-5 text-gray-600 dark:text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
              </svg>
            </button>
            <button
              onClick={() => setCurrentMonth(new Date())}
              className="ml-2 px-3 py-1 text-sm text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-md"
            >
              {t('upcomingBills.todayButton')}
            </button>
          </div>
          <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
            <div className={SEGMENTED_GROUP_CLASS} role="group" aria-label={t('reportPage.viewLabel')}>
              <button
                type="button"
                onClick={() => setViewType('calendar')}
                aria-pressed={viewType === 'calendar'}
                className={segmentClass(viewType === 'calendar')}
              >
                {t('upcomingBills.calendarView')}
              </button>
              <button
                type="button"
                onClick={() => setViewType('list')}
                aria-pressed={viewType === 'list'}
                className={segmentClass(viewType === 'list')}
              >
                {t('upcomingBills.listView')}
              </button>
            </div>
          </div>
          <ReportToolbarActions
            onExportCsv={handleExportCsv}
            onExportPdf={handleExportPdf}
            disabled={upcomingBills.length === 0}
          />
        </div>
      </div>

      {scheduledTransactions.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <EmptyState title={t('upcomingBills.noBills')} />
        </div>
      ) : viewType === 'calendar' ? (
        /* Calendar View */
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="grid grid-cols-7">
            {([t('upcomingBills.dayLabels.sun'), t('upcomingBills.dayLabels.mon'), t('upcomingBills.dayLabels.tue'), t('upcomingBills.dayLabels.wed'), t('upcomingBills.dayLabels.thu'), t('upcomingBills.dayLabels.fri'), t('upcomingBills.dayLabels.sat')]).map((day) => (
              <div
                key={day}
                className="px-2 py-3 text-center text-sm font-medium text-gray-500 dark:text-gray-400 border-b border-gray-200 dark:border-gray-700"
              >
                {day}
              </div>
            ))}
          </div>
          <div className="grid grid-cols-7">
            {calendarDays.map((day, index) => (
              <div
                key={index}
                className={`min-h-[100px] p-1 border-b border-r border-gray-200 dark:border-gray-700 ${
                  !day.isCurrentMonth
                    ? 'bg-gray-50 dark:bg-gray-900/50'
                    : 'bg-white dark:bg-gray-800'
                }`}
              >
                <div
                  className={`text-sm font-medium mb-1 w-7 h-7 flex items-center justify-center rounded-full ${
                    day.isToday
                      ? 'bg-blue-600 text-white'
                      : day.isCurrentMonth
                      ? 'text-gray-900 dark:text-gray-100'
                      : 'text-gray-400 dark:text-gray-600'
                  }`}
                >
                  {format(day.date, 'd')}
                </div>
                <div className="space-y-0.5">
                  {day.bills.slice(0, 3).map((bill, billIndex) => {
                    const st = bill.scheduledTransaction;
                    return (
                      <div
                        key={billIndex}
                        onClick={() => handleBillClick(st)}
                        className={`px-1 py-0.5 text-xs rounded truncate cursor-pointer flex items-center gap-0.5 ${
                          SCHEDULED_KIND_CHIP_CLASSES[occurrenceKind(bill, st)]
                        } hover:opacity-80`}
                        title={st.autoPost ? t('upcomingBills.calendarAutoTitle', { name: st.name }) : t('upcomingBills.calendarManualTitle', { name: st.name })}
                      >
                        {!st.autoPost && (
                          <svg className="h-3 w-3 flex-shrink-0 text-amber-600 dark:text-amber-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 9v2m0 4h.01" />
                          </svg>
                        )}
                        <span className="truncate">{st.name}</span>
                      </div>
                    );
                  })}
                  {day.bills.length > 3 && (
                    <div className="text-xs text-gray-500 dark:text-gray-400 px-1">
                      {t('upcomingBills.moreItems', { count: day.bills.length - 3 })}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        /* List View */
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
          <div className="divide-y divide-gray-200 dark:divide-gray-700">
            {upcomingBills.slice(0, 50).map((bill, index) => (
              <div
                key={`${bill.scheduledTransaction.id}-${index}`}
                onClick={() => handleBillClick(bill.scheduledTransaction)}
                className={`px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/50 ${
                  bill.isOverdue ? 'bg-red-50 dark:bg-red-900/10' : ''
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-medium ${
                      bill.isOverdue
                        ? 'text-red-600 dark:text-red-400'
                        : 'text-gray-900 dark:text-gray-100'
                    }`}>
                      {bill.scheduledTransaction.name}
                    </span>
                    {bill.isOverdue && (
                      <span className="px-1.5 py-0.5 bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-400 text-xs rounded">
                        {t('upcomingBills.overdueLabel')}
                      </span>
                    )}
                    {bill.scheduledTransaction.autoPost ? (
                      <span className="px-1.5 py-0.5 bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-400 text-xs rounded">
                        {t('upcomingBills.autoLabel')}
                      </span>
                    ) : (
                      <span className="px-1.5 py-0.5 bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-400 text-xs rounded font-medium">
                        {t('upcomingBills.manualLabel')}
                      </span>
                    )}
                  </div>
                  <div className="text-sm text-gray-500 dark:text-gray-400">
                    {bill.scheduledTransaction.payee?.name || bill.scheduledTransaction.payeeName || t('upcomingBills.noPayee')}
                  </div>
                </div>
                <div className="text-right">
                  <div className={`font-medium ${
                    SCHEDULED_KIND_AMOUNT_CLASSES[
                      occurrenceKind(bill, bill.scheduledTransaction)
                    ]
                  }`}>
                    {bill.amount === null ? (
                      <UnknownAmount />
                    ) : (
                      // In the occurrence's OWN currency: the settlement one for
                      // an investment, which need not be the reader's default.
                      // Omitting the code formatted a CAD figure with a USD
                      // symbol (issue #1247).
                      formatCurrency(Math.abs(bill.amount), bill.currencyCode)
                    )}
                  </div>
                  {bill.estimated && (
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {t('upcomingBills.estimated')}
                    </div>
                  )}
                  <div className="text-sm text-gray-500 dark:text-gray-400">
                    {formatDate(bill.dueDate)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
