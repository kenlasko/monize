'use client';

import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { MonthGrid, type MonthGridHandle } from '@/components/ui/MonthGrid';
import { ReportError } from '@/components/reports/ReportError';
import { CalendarBanner, type CalendarCause } from '@/components/calendar/CalendarBanner';
import { CalendarBalanceFigure, CalendarDayCell } from '@/components/calendar/CalendarDayCell';
import {
  CalendarDayPanel,
  type CalendarDayBalance,
} from '@/components/calendar/CalendarDayPanel';
import { CalendarNoteSpans } from '@/components/calendar/CalendarNoteSpans';
import { CalendarToolbar } from '@/components/calendar/CalendarToolbar';
import {
  CALENDAR_MAX_ROWS,
  useCalendarMonthData,
  type CalendarRowFilters,
} from '@/hooks/useCalendarMonthData';
import { useDailyBalanceTotals } from '@/hooks/useDailyBalanceTotals';
import {
  groupCalendarRows,
  type CalendarAccount,
  type CalendarDayRows,
} from '@/lib/calendar-rows';
import {
  CALENDAR_MONTH_PAGES,
  monthFromPageNumber,
  monthGridDays,
  monthOf,
  monthPageNumber,
  type WeekStart,
} from '@/lib/calendar-month';
import { useSwipeToPaginate } from '@/hooks/useSwipeToPaginate';
import { SWIPE_PAGINATE_ATTR } from '@/hooks/swipe-gesture';
import { occurrenceTouchesAccounts } from '@/lib/scheduled-effective-amount';
import { useCalendarDayNotes } from '@/hooks/useCalendarDayNotes';
import { useAuthStore } from '@/store/authStore';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useViewMode } from '@/store/viewModeStore';
import type { Account, AccountType } from '@/types/account';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';
import type { Transaction } from '@/types/transaction';

/** How many chips a day cell draws before the rest become a "+N more" line. */
export const CALENDAR_DAY_CHIP_LIMIT = 3;

const LAYERS = ['transactions', 'balances'] as const;

interface TransactionsCalendarViewProps {
  accounts: readonly Account[];
  scheduledTransactions: readonly ScheduledTransaction[];
  /** The page's filters, minus the date range the month replaces. */
  filters: CalendarRowFilters;
  /** Accounts in scope: the filter's, or every active account when none is chosen. */
  scopeAccountIds: readonly string[];
  weekStartsOn: WeekStart;
  /** Today, for the month the calendar opens on and for dimming a future row. */
  today: string;
  categoryColorMap: ReadonlyMap<string, string | null>;
  categoryIconMap: ReadonlyMap<string, string | null>;
  categoryLabelMap: ReadonlyMap<string, string>;
  onEditTransaction: (transaction: Transaction) => void;
  onCreateOnDay: (date: string) => void;
  /** Bumped by the page after a write, so the month refetches. */
  refreshKey?: number;
  /**
   * The Table / Calendar switch, drawn at the right-hand end of the toolbar row
   * so it sits with the month navigation and the legend rather than up beside
   * the page title. The page owns it; this only says where it goes.
   */
  viewToggle?: React.ReactNode;
}

/**
 * The Transactions page's month calendar.
 *
 * It replaces the register card in calendar mode and nothing else: the filter
 * panel, the chart above it and every write path stay the page's. Its figures
 * are the register endpoint's rows and the occurrence endpoint's amounts, one
 * chip each -- nothing here sums a day, converts a currency or expands a
 * recurrence (design I1).
 */
export function TransactionsCalendarView({
  accounts,
  scheduledTransactions,
  filters,
  scopeAccountIds,
  weekStartsOn,
  today,
  categoryColorMap,
  categoryIconMap,
  categoryLabelMap,
  onEditTransaction,
  onCreateOnDay,
  refreshKey = 0,
  viewToggle,
}: TransactionsCalendarViewProps) {
  const t = useTranslations('calendar');
  const monthLabelId = useId();
  const { layers, toggleLayer } = useViewMode('transactions');

  const [month, setMonth] = useState(() => monthOf(today));
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const gridRef = useRef<MonthGridHandle>(null);

  const days = useMemo(() => monthGridDays(month, weekStartsOn), [month, weekStartsOn]);
  const gridStart = days[0];
  const gridEnd = days[days.length - 1];

  // A note is personal and its routes are not delegate-reachable, so an acting
  // delegate has no note surface and asks for nothing.
  const isActingDelegate = useAuthStore((state) => !!state.actingAsUserId);
  const notes = useCalendarDayNotes({
    startDate: gridStart,
    endDate: gridEnd,
    enabled: !isActingDelegate,
  });

  /**
   * Move to another month.
   *
   * The toolbar's arrows, its month picker and the swipe across the grid all
   * come through here, so every way of changing the month asks about an unsaved
   * note the same way and leaves no day selected from the month being left.
   */
  const goToMonth = useCallback(
    (next: string) => {
      notes.requestChange(() => {
        setMonth(next);
        setSelectedDate(null);
      });
    },
    [notes],
  );

  // A horizontal swipe across the grid turns the month the way one turns a
  // register page: the months ARE the pages (`monthPageNumber`), so the gesture
  // is the register's, not a second one written here. The grid is marked as a
  // pagination zone so the view-level swipe cedes to it instead of leaving the
  // page for the next section of the app.
  const { swipeRef } = useSwipeToPaginate({
    page: monthPageNumber(month),
    totalPages: CALENDAR_MONTH_PAGES,
    onPageChange: (page) => goToMonth(monthFromPageNumber(page)),
  });

  const data = useCalendarMonthData(gridStart, gridEnd, filters, refreshKey);

  // The Balances layer is scoped by ACCOUNTS only: a balance filtered by
  // category or payee would be the balance of a subset of the rows that moved
  // it, which is not a balance of anything (design decision 2).
  const balancesOn = layers.includes('balances');
  const balances = useDailyBalanceTotals({
    startDate: gridStart,
    endDate: gridEnd,
    accountIds: scopeAccountIds,
    enabled: balancesOn,
    refreshKey,
  });
  const balanceCurrency = balances.data?.currencyCode ?? null;
  const forecast = balances.data?.forecast ?? null;
  const scopeEmpty = balances.data?.scopeEmpty === true;
  // A figure is drawn only while the layer is on, the response belongs to the
  // month on screen, and the scope it describes holds an account.
  const balancesReady = balancesOn && !balances.isStale && !scopeEmpty && balanceCurrency !== null;

  const accountsById = useMemo(() => {
    const map = new Map<string, CalendarAccount>();
    for (const account of accounts) {
      map.set(account.id, {
        id: account.id,
        accountType: account.accountType,
        linkedAccountId: account.linkedAccountId,
      });
    }
    return map;
  }, [accounts]);

  const schedulesById = useMemo(
    () => new Map(scheduledTransactions.map((s) => [s.id, s])),
    [scheduledTransactions],
  );

  const scope = useMemo(() => new Set(scopeAccountIds), [scopeAccountIds]);

  const byDay = useMemo(() => {
    if (!data.data || data.data.withheld) return new Map<string, CalendarDayRows>();
    return groupCalendarRows({
      transactions: data.data.transactions,
      // The account scope is applied here rather than in the request: which
      // account an occurrence charges is `occurrenceTouchesAccounts`'s answer,
      // and it needs the schedules, which are reference data.
      occurrences: data.data.occurrences.filter((occurrence) => {
        const schedule = schedulesById.get(occurrence.scheduledTransactionId);
        return (
          schedule !== undefined &&
          occurrenceTouchesAccounts(occurrence, schedule, accountsById, scope)
        );
      }),
      schedulesById,
      accountsById,
      today,
    });
  }, [data.data, schedulesById, accountsById, scope, today]);

  const legend = useMemo(() => {
    const accountTypes = new Set<AccountType>();
    let hasScheduled = false;
    for (const rows of byDay.values()) {
      for (const chip of rows.transactions) {
        accountTypes.add(accountsById.get(chip.transaction.accountId)?.accountType ?? 'OTHER');
      }
      if (rows.occurrences.length > 0) hasScheduled = true;
    }
    return { accountTypes: [...accountTypes], hasScheduled };
  }, [byDay, accountsById]);

  const causes = useMemo<CalendarCause[]>(() => {
    const found: CalendarCause[] = [];
    if (data.data?.withheld) {
      found.push({
        key: 'rowCap',
        message: t('banner.rowCap', {
          count: data.data.rowCount,
          limit: CALENDAR_MAX_ROWS,
        }),
      });
    }
    // A month that draws its rows but not its scheduled items says so here.
    // Silence would read as "nothing is due", which is the one answer the
    // calendar does not have.
    if (data.data?.occurrencesUnavailable) {
      found.push({
        key: 'scheduledUnavailable',
        message: t('banner.scheduledUnavailable'),
      });
    }
    if (data.data?.occurrencesTruncated) {
      found.push({
        key: 'scheduledTruncated',
        message: t('banner.scheduledTruncated'),
      });
    }

    // Before the Balances layer's own causes, which return early: a note that
    // could not be loaded is a cause whether or not that layer is on.
    if (notes.error !== null) {
      found.push({ key: 'notesUnavailable', message: t('banner.notesUnavailable') });
    }

    if (!balancesOn || balances.data === null) return found;

    if (scopeEmpty) {
      found.push({ key: 'balancesScopeEmpty', message: t('banner.balancesScopeEmpty') });
      return found;
    }

    // Every pair the month could not price, named once rather than once per day:
    // the same missing rate withholds every day it is needed on.
    const pairs = [
      ...new Set(balances.data.days.flatMap((day) => day.missingRatePairs)),
    ].sort();
    if (pairs.length > 0) {
      found.push({
        key: 'balancesMissingRates',
        message: t('banner.balancesMissingRates', { pairs: pairs.join(', ') }),
      });
    }

    if (!balances.data.forecast.complete) {
      const names = balances.data.forecast.gaps.map((gap) => gap.name);
      found.push({
        key: 'balancesForecastGaps',
        message:
          names.length > 0
            ? t('banner.balancesForecastGaps', { schedules: names.join(', ') })
            : t('banner.balancesForecastWithheld'),
      });
    }

    if (balances.data.forecast.unforecastableAccountIds.length > 0) {
      found.push({
        key: 'balancesUnforecastable',
        message: t('banner.balancesUnforecastable', {
          count: balances.data.forecast.unforecastableAccountIds.length,
        }),
      });
    }

    return found;
  }, [data.data, balances.data, balancesOn, scopeEmpty, notes.error, t]);

  const selectedBalance = useMemo<CalendarDayBalance | undefined>(() => {
    if (!balancesReady || selectedDate === null) return undefined;
    const point = balances.byDay.get(selectedDate);
    if (!point || balanceCurrency === null || forecast === null) return undefined;
    return { point, currencyCode: balanceCurrency, forecast };
  }, [balancesReady, selectedDate, balances.byDay, balanceCurrency, forecast]);

  // Stale data may stay on screen; it may not stay actionable.
  /**
   * Close the day panel and put focus back where it came from.
   *
   * A panel opened from a cell took focus with it; dropping focus on the
   * document instead would make a keyboard reader start the month again.
   */
  const closePanel = useCallback(() => {
    const returningTo = selectedDate;
    notes.requestChange(() => {
      setSelectedDate(null);
      if (returningTo !== null) gridRef.current?.focusDay(returningTo);
    });
  }, [notes, selectedDate]);

  const isActionable = !data.isLoading && !data.isStale && data.error === null;

  if (data.error !== null && data.data === null) {
    return <ReportError message={t('errors.monthFailed')} onRetry={data.reload} />;
  }

  return (
    <div>
      <CalendarToolbar
        month={month}
        onMonthChange={goToMonth}
        today={today}
        monthLabelId={monthLabelId}
        availableLayers={LAYERS}
        activeLayers={layers}
        onToggleLayer={toggleLayer}
        legendAccountTypes={legend.accountTypes}
        legendHasScheduled={legend.hasScheduled}
        viewToggle={viewToggle}
      />

      <CalendarBanner causes={causes} />

      {data.error !== null && (
        <div className="mb-3">
          <ReportError message={t('errors.monthFailed')} onRetry={data.reload} />
        </div>
      )}

      {/* The Balances layer fails on its own terms: the rows and occurrences
          below are unaffected by a balance request that did not answer. */}
      {balancesOn && balances.error !== null && (
        <div className="mb-3">
          <ReportError message={t('errors.balancesFailed')} onRetry={balances.reload} />
        </div>
      )}

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div
          ref={swipeRef}
          {...{ [SWIPE_PAGINATE_ATTR]: 'true' }}
          className="min-w-0 flex-1"
          aria-busy={data.isLoading || (balancesOn && balances.isLoading)}
          inert={!isActionable}
        >
          <MonthGrid
            ref={gridRef}
            month={month}
            weekStartsOn={weekStartsOn}
            today={today}
            selectedDate={selectedDate}
            onSelectDay={(day) => notes.requestChange(() => setSelectedDate(day))}
            labelledBy={monthLabelId}
            // A note belongs to a run of days, not to one, so it is drawn once
            // across the days it covers rather than once per cell.
            renderWeekSpans={(week) => <CalendarNoteSpans week={week} byDay={notes.byDay} />}
            renderDay={(day) => {
              const point = balancesReady ? balances.byDay.get(day.date) : undefined;
              return (
                <CalendarDayCell
                  day={day}
                  rows={layers.includes('transactions') ? byDay.get(day.date) : undefined}
                  chipLimit={CALENDAR_DAY_CHIP_LIMIT}
                  onOpenDay={(day) => notes.requestChange(() => setSelectedDate(day))}
                  onEditTransaction={onEditTransaction}
                  note={notes.byDay.get(day.date)}
                  figure={
                    point && balanceCurrency !== null ? (
                      <CalendarBalanceFigure point={point} currencyCode={balanceCurrency} />
                    ) : undefined
                  }
                />
              );
            }}
          />
        </div>

        {selectedDate !== null && (
          // Wide enough for the note editor's two date fields side by side: at
          // 20rem they shared 18rem between them and both read as truncated
          // dates, which is the one thing a date field must not do.
          <div className="lg:w-96 lg:shrink-0">
            <CalendarDayPanel
              date={selectedDate}
              rows={layers.includes('transactions') ? byDay.get(selectedDate) : undefined}
              balance={selectedBalance}
              notes={
                // No surface for an acting delegate (the routes are not theirs
                // to call), and none while the list is absent: "this day has no
                // note" is a claim only a loaded list can make, and the save is
                // a whole-body upsert that would replace a note nobody saw. The
                // banner already carries why it is absent.
                isActingDelegate || !notes.loaded
                  ? undefined
                  : {
                      note: notes.byDay.get(selectedDate),
                      onSave: notes.save,
                      onDelete: notes.remove,
                      onDirtyChange: notes.setDraftDirty,
                    }
              }
              onEditTransaction={onEditTransaction}
              onCreateOnDay={onCreateOnDay}
              onClose={closePanel}
              categoryColorMap={categoryColorMap}
              categoryIconMap={categoryIconMap}
              categoryLabelMap={categoryLabelMap}
            />
          </div>
        )}
      </div>

      <ConfirmDialog
        isOpen={notes.confirmDiscard.isOpen}
        title={t('notes.discardTitle')}
        message={t('notes.discardMessage')}
        confirmLabel={t('notes.discardConfirm')}
        variant="warning"
        onConfirm={notes.confirmDiscard.onConfirm}
        onCancel={notes.confirmDiscard.onCancel}
      />
    </div>
  );
}
