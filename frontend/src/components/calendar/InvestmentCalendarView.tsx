'use client';

import { useCallback, useId, useMemo, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { MonthGrid, type MonthGridHandle } from '@/components/ui/MonthGrid';
import { ReportError } from '@/components/reports/ReportError';
import { CalendarBanner, type CalendarCause } from '@/components/calendar/CalendarBanner';
import {
  CalendarChangeFigure,
  CalendarDayCell,
  CalendarValueFigure,
} from '@/components/calendar/CalendarDayCell';
import { DailyMovementDialog } from '@/components/calendar/DailyMovementDialog';
import {
  CalendarDayPanel,
  type CalendarDayValue,
} from '@/components/calendar/CalendarDayPanel';
import { CalendarToolbar } from '@/components/calendar/CalendarToolbar';
import { CALENDAR_DAY_CHIP_LIMIT } from '@/components/calendar/TransactionsCalendarView';
import {
  CALENDAR_MAX_ROWS,
  useInvestmentCalendarMonthData,
} from '@/hooks/useCalendarMonthData';
import { useInvestmentDailyValues } from '@/hooks/useInvestmentDailyValues';
import { useDailyMovements } from '@/hooks/useDailyMovements';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import {
  dedupeInvestmentLegs,
  groupInvestmentCalendarRows,
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
import { preferredCurrency } from '@/lib/default-currency';
import { useCalendarDayNotes } from '@/hooks/useCalendarDayNotes';
import { useAuthStore } from '@/store/authStore';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { useViewMode } from '@/store/viewModeStore';
import type { Account, AccountType } from '@/types/account';
import type { DailyMovementReason, InvestmentTransaction } from '@/types/investment';
import type { Transaction } from '@/types/transaction';

const LAYERS = ['transactions', 'values', 'dailyChange'] as const;

/**
 * The catalogue key for one withheld-movement reason.
 *
 * Written as its own function for the reason `CalendarToolbar`'s
 * `layerLabelKey` is: a key built inline from a `for ... of` binding widens to
 * `string`, which next-intl cannot resolve to a message.
 */
function movementReasonKey(
  reason: DailyMovementReason,
): `change.reasons.${DailyMovementReason}` {
  return `change.reasons.${reason}`;
}

interface InvestmentCalendarViewProps {
  /** Every account the page holds, for the cash chips' colours. */
  accounts: readonly Account[];
  /** The selected brokerage accounts; empty means every investment account. */
  brokerageAccountIds: readonly string[];
  /** Their linked cash sleeves, as the page derives them. */
  cashAccountIds: readonly string[];
  /**
   * Symbols for the securities the scope HOLDS, keyed by security id.
   *
   * A withheld value names the security behind it, and the month's own rows only
   * name what the month traded -- which the security that went unpriced usually
   * was not. Without the held set, a position bought in March and unpriced ever
   * since is reported to a June reader as its UUID, which is a repair
   * instruction nobody can follow.
   */
  heldSecurityLabels?: ReadonlyMap<string, string>;
  weekStartsOn: WeekStart;
  /** The financial today: which month opens, and where the Values layer stops. */
  today: string;
  /** The single selected account's currency, or null for the reader's default. */
  displayCurrency?: string | null;
  onEditInvestment: (transaction: InvestmentTransaction) => void;
  onEditCashTransaction: (transaction: Transaction) => void;
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
 * The Investments page's month calendar.
 *
 * It stands in for the brokerage and cash registers, and for nothing else: the
 * summary, the allocation and the chart above it are untouched. A trade and the
 * cash leg that settles it are one chip (I5), and every figure -- a row's total,
 * a day's market value -- is the one the server sent for it (I1).
 */
export function InvestmentCalendarView({
  accounts,
  brokerageAccountIds,
  cashAccountIds,
  heldSecurityLabels,
  weekStartsOn,
  today,
  displayCurrency = null,
  onEditInvestment,
  onEditCashTransaction,
  onCreateOnDay,
  refreshKey = 0,
  viewToggle,
}: InvestmentCalendarViewProps) {
  const t = useTranslations('calendar');
  const monthLabelId = useId();
  const { layers, toggleLayer } = useViewMode('investments');
  const { defaultCurrency } = useExchangeRates();

  const [month, setMonth] = useState(() => monthOf(today));
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const gridRef = useRef<MonthGridHandle>(null);
  /** The day whose gain/loss breakdown is open, if any. */
  const [movementDate, setMovementDate] = useState<string | null>(null);

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
   * Move to another month: the toolbar's arrows, its month picker and the swipe
   * across the grid all come through here, so every way of changing the month
   * asks about an unsaved note the same way and leaves no day selected from the
   * month being left.
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

  // The same gesture the register and the Transactions calendar use: a swipe
  // turns the page, and here the months ARE the pages (`monthPageNumber`). The
  // grid is marked as a pagination zone so the view-level swipe cedes to it.
  const { swipeRef } = useSwipeToPaginate({
    page: monthPageNumber(month),
    totalPages: CALENDAR_MONTH_PAGES,
    onPageChange: (page) => goToMonth(monthFromPageNumber(page)),
  });

  // The same resolution the portfolio chart makes: a foreign single-account
  // currency is asked for explicitly, and anything else is the reader's own
  // reporting currency, which is what the endpoint falls back to.
  const foreignCurrency =
    displayCurrency && displayCurrency !== defaultCurrency ? displayCurrency : null;
  const reportingCurrency = foreignCurrency ?? preferredCurrency(defaultCurrency);

  const data = useInvestmentCalendarMonthData(
    gridStart,
    gridEnd,
    brokerageAccountIds,
    cashAccountIds,
    refreshKey,
  );

  const valuesOn = layers.includes('values');
  const values = useInvestmentDailyValues({
    startDate: gridStart,
    endDate: gridEnd,
    today,
    accountIds: brokerageAccountIds,
    displayCurrency: foreignCurrency ?? undefined,
    enabled: valuesOn,
    refreshKey,
  });
  const valuesReady = valuesOn && !values.isStale;

  const changeOn = layers.includes('dailyChange');
  const movements = useDailyMovements({
    startDate: gridStart,
    endDate: gridEnd,
    today,
    accountIds: brokerageAccountIds,
    displayCurrency: foreignCurrency ?? undefined,
    enabled: changeOn,
    refreshKey,
  });
  const changeReady = changeOn && !movements.isStale;

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

  const byDay = useMemo(() => {
    if (!data.data || data.data.withheld) return new Map<string, CalendarDayRows>();
    const brokerageIds = new Set(data.data.brokerage.map((row) => row.id));
    return groupInvestmentCalendarRows({
      brokerage: data.data.brokerage,
      cash: dedupeInvestmentLegs(data.data.cash, brokerageIds),
      accountsById,
      today,
    });
  }, [data.data, accountsById, today]);

  /**
   * Symbols for every security a withheld value might name.
   *
   * The scope's current holdings first, because an unpriced position is usually
   * one the month on screen did not trade; the month's own rows on top, so a
   * security bought and sold inside it is still named after the holding is gone.
   * An id that survives both is printed as itself, which is the honest last
   * resort rather than a blank.
   */
  const securityLabels = useMemo(() => {
    const labels = new Map<string, string>(heldSecurityLabels);
    for (const row of data.data?.brokerage ?? []) {
      if (row.security?.id && row.security.symbol) labels.set(row.security.id, row.security.symbol);
    }
    return labels;
  }, [data.data, heldSecurityLabels]);

  const legend = useMemo(() => {
    const accountTypes = new Set<AccountType>();
    for (const rows of byDay.values()) {
      if (rows.investments.length > 0) accountTypes.add('INVESTMENT');
      for (const chip of rows.transactions) {
        accountTypes.add(accountsById.get(chip.transaction.accountId)?.accountType ?? 'OTHER');
      }
    }
    return [...accountTypes];
  }, [byDay, accountsById]);

  const causes = useMemo<CalendarCause[]>(() => {
    const found: CalendarCause[] = [];

    if (data.data?.withheld) {
      found.push({
        key: 'rowCap',
        message: t('banner.rowCap', { count: data.data.rowCount, limit: CALENDAR_MAX_ROWS }),
      });
    }

    // A note that could not be loaded is a cause whether or not a figure layer
    // is on, so it is composed before either of them.
    if (notes.error !== null) {
      found.push({ key: 'notesUnavailable', message: t('banner.notesUnavailable') });
    }

    if (valuesOn) {
      const unpriced = new Set<string>();
      const pairs = new Set<string>();
      for (const point of values.byDay.values()) {
        if (point.pricesComplete === false) {
          for (const id of point.unpricedSecurityIds ?? []) unpriced.add(id);
        }
        if (point.fxComplete === false) {
          for (const pair of point.missingRatePairs ?? []) pairs.add(pair);
        }
      }

      if (unpriced.size > 0) {
        found.push({
          key: 'valuesUnpriced',
          message: t('banner.valuesUnpriced', {
            securities: [...unpriced].map((id) => securityLabels.get(id) ?? id).join(', '),
          }),
        });
      }
      if (pairs.size > 0) {
        found.push({
          key: 'valuesMissingRates',
          message: t('banner.valuesMissingRates', { pairs: [...pairs].sort().join(', ') }),
        });
      }
    }

    // The change layer's causes, composed once for the month.
    //
    // Without this a withheld percentage has no surface that says why it was
    // withheld: the cell can carry one marker for six reasons, and
    // `DailyMovementDialog`, which does list the server's own wording, opens
    // only from the percentage button a COMPLETE day draws. `zeroBaseline` is
    // not a cause here -- that day is deliberately blank rather than withheld,
    // so there is nothing for the reader to repair.
    if (changeOn) {
      const reasons = new Set<DailyMovementReason>();
      for (const point of movements.byDay.values()) {
        if (!point.isTradingDay || point.complete) continue;
        for (const reason of point.reasons) {
          if (reason !== 'zeroBaseline') reasons.add(reason);
        }
      }
      for (const reason of reasons) {
        found.push({ key: `change:${reason}`, message: t(movementReasonKey(reason)) });
      }
    }

    return found;
  }, [
    data.data,
    valuesOn,
    values.byDay,
    changeOn,
    movements.byDay,
    securityLabels,
    notes.error,
    t,
  ]);

  const selectedValue = useMemo<CalendarDayValue | undefined>(() => {
    if (!valuesReady || selectedDate === null) return undefined;
    const point = values.byDay.get(selectedDate);
    if (!point) return undefined;
    return { point, currencyCode: reportingCurrency, securityLabels };
  }, [valuesReady, selectedDate, values.byDay, reportingCurrency, securityLabels]);

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
        legendAccountTypes={legend}
        legendHasScheduled={false}
        viewToggle={viewToggle}
      />

      <CalendarBanner causes={causes} />

      {data.error !== null && (
        <div className="mb-3">
          <ReportError message={t('errors.monthFailed')} onRetry={data.reload} />
        </div>
      )}

      {valuesOn && values.error !== null && (
        <div className="mb-3">
          <ReportError message={t('errors.valuesFailed')} onRetry={values.reload} />
        </div>
      )}

      {changeOn && movements.error !== null && (
        <div className="mb-3">
          <ReportError message={t('errors.movementsFailed')} onRetry={movements.reload} />
        </div>
      )}

      <div className="flex flex-col gap-4 lg:flex-row lg:items-start">
        <div
          ref={swipeRef}
          {...{ [SWIPE_PAGINATE_ATTR]: 'true' }}
          className="min-w-0 flex-1"
          aria-busy={
            data.isLoading ||
            (valuesOn && values.isLoading) ||
            (changeOn && movements.isLoading)
          }
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
            renderDay={(day) => {
              const point = valuesReady ? values.byDay.get(day.date) : undefined;
              const movement = changeReady ? movements.byDay.get(day.date) : undefined;
              return (
                <CalendarDayCell
                  day={day}
                  rows={layers.includes('transactions') ? byDay.get(day.date) : undefined}
                  chipLimit={CALENDAR_DAY_CHIP_LIMIT}
                  onOpenDay={(day) => notes.requestChange(() => setSelectedDate(day))}
                  onEditTransaction={onEditCashTransaction}
                  onEditInvestment={onEditInvestment}
                  note={notes.byDay.get(day.date)}
                  figure={
                    point || movement ? (
                      <span className="flex items-baseline gap-1">
                        {point && (
                          <CalendarValueFigure point={point} currencyCode={reportingCurrency} />
                        )}
                        {movement && (
                          <CalendarChangeFigure
                            point={movement}
                            onOpenDetail={setMovementDate}
                          />
                        )}
                      </span>
                    ) : undefined
                  }
                />
              );
            }}
          />
        </div>

        {selectedDate !== null && (
          <div className="lg:w-80 lg:shrink-0">
            <CalendarDayPanel
              date={selectedDate}
              rows={layers.includes('transactions') ? byDay.get(selectedDate) : undefined}
              value={selectedValue}
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
              onEditTransaction={onEditCashTransaction}
              onEditInvestment={onEditInvestment}
              createLabel={t('day.newInvestmentTransaction')}
              onCreateOnDay={onCreateOnDay}
              onClose={closePanel}
              categoryColorMap={EMPTY_CATEGORY_MAP}
              categoryIconMap={EMPTY_CATEGORY_MAP}
              categoryLabelMap={EMPTY_CATEGORY_LABELS}
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

      <DailyMovementDialog
        date={movementDate}
        accountIds={brokerageAccountIds}
        displayCurrency={foreignCurrency ?? undefined}
        onClose={() => setMovementDate(null)}
      />
    </div>
  );
}

/**
 * The Investments page holds no category maps: its cash register draws no
 * category pill, so an empty map is the honest answer rather than a lookup that
 * would be half-populated.
 */
const EMPTY_CATEGORY_MAP: ReadonlyMap<string, string | null> = new Map();
const EMPTY_CATEGORY_LABELS: ReadonlyMap<string, string> = new Map();
