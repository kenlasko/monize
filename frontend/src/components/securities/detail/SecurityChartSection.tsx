'use client';

import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';
import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  ChevronLeftIcon,
  ChevronRightIcon,
} from '@heroicons/react/24/outline';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import {
  BalanceHistoryChart,
  type ChartMarker,
} from '@/components/transactions/BalanceHistoryChart';
import { useDateRange } from '@/hooks/useDateRange';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import {
  CHART_RANGES,
  buildChartSeries,
  filterPriceWindow,
  maxSpansBack,
  shiftWindow,
  type SecurityChartMode,
  type SecurityPricePoint,
  type QuantityStep,
} from '@/lib/security-detail';
import type {
  Security,
  SecurityHistoryTransaction,
} from '@/types/investment';

interface SecurityChartSectionProps {
  security: Security;
  /** Full close-price history, oldest first. */
  prices: readonly SecurityPricePoint[];
  /** Position size over time, for the investment-value series. */
  quantitySteps: readonly QuantityStep[];
  trades: readonly SecurityHistoryTransaction[];
  isLoading: boolean;
  mode: SecurityChartMode;
  onModeChange: (mode: SecurityChartMode) => void;
}

const MODES: readonly SecurityChartMode[] = ['price', 'value', 'return'];

/** Which way each action moved the position; the rest carry no shares. */
const MARKER_DIRECTION: Partial<
  Record<SecurityHistoryTransaction['action'], 'in' | 'out'>
> = {
  BUY: 'in',
  REINVEST: 'in',
  TRANSFER_IN: 'in',
  ADD_SHARES: 'in',
  SELL: 'out',
  TRANSFER_OUT: 'out',
  REMOVE_SHARES: 'out',
};

/**
 * The page's main chart: the same chart the price-history modal and the account
 * pages draw, given a choice of series and a time window.
 *
 * The three series answer three different questions from the same history --
 * what one unit cost, what the whole position was worth, and how far the price
 * has moved in the window. Only the third is not money, which is why the chart
 * is told to write it as a percentage.
 */
export function SecurityChartSection({
  security,
  prices,
  quantitySteps,
  trades,
  isLoading,
  mode,
  onModeChange,
}: SecurityChartSectionProps) {
  const t = useTranslations('securityDetail');
  const ts = useTranslations('securities');
  const { formatQuantity } = useNumberFormat();

  // Per-security key, so switching securities does not inherit the last one's
  // window while the choice still survives leaving and coming back.
  const { dateRange, setDateRange, resolvedRange } = useDateRange({
    defaultRange: '1y',
    storageKey: `securityDetail:range:${security.id}`,
  });

  // How many windows back from the latest one is on screen. The range preset
  // picks how much history to show; this picks which stretch of it, so a reader
  // on 1Y can walk back year by year at the same zoom instead of switching to 5Y
  // and squinting at a compressed line.
  const [spansBack, setSpansBack] = useState(0);
  // Information from the previous render: changing the preset changes what a
  // step even means, so the walk starts again from the latest window.
  const [lastPreset, setLastPreset] = useState(dateRange);
  if (dateRange !== lastPreset) {
    setLastPreset(dateRange);
    setSpansBack(0);
  }

  // "All" already shows everything and has no start date to move.
  const isPannable = dateRange !== 'all' && !!resolvedRange.start;
  const oldestDate = prices[0]?.date ?? '';

  const window = useMemo(() => {
    const latest = { start: resolvedRange.start, end: resolvedRange.end };
    return isPannable ? shiftWindow(latest, spansBack) : latest;
  }, [resolvedRange.start, resolvedRange.end, isPannable, spansBack]);

  const stepsAvailable = useMemo(
    () =>
      isPannable
        ? maxSpansBack(
            { start: resolvedRange.start, end: resolvedRange.end },
            oldestDate,
          )
        : 0,
    [isPannable, resolvedRange.start, resolvedRange.end, oldestDate],
  );

  const series = useMemo(() => {
    const points = filterPriceWindow(prices, window.start, window.end);
    return buildChartSeries(points, quantitySteps, mode);
  }, [prices, quantitySteps, window.start, window.end, mode]);

  const markers = useMemo<ChartMarker[]>(
    () =>
      trades.flatMap((trade) => {
        const direction = MARKER_DIRECTION[trade.action];
        if (!direction || trade.quantity === null) return [];
        return [
          {
            date: trade.transactionDate.slice(0, 10),
            direction,
            label: ts(
              direction === 'in'
                ? 'priceHistory.markers.bought'
                : 'priceHistory.markers.sold',
              {
                quantity: formatQuantity(Math.abs(Number(trade.quantity))),
                account: trade.accountName,
              },
            ),
          },
        ];
      }),
    [trades, ts, formatQuantity],
  );

  return (
    // No wrapping card: `BalanceHistoryChart` already draws one, and nesting a
    // second would double the border and padding. The controls sit directly
    // above it instead, as they do on the portfolio charts.
    <div>
      <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div
          role="group"
          aria-label={t('chart.seriesAriaLabel')}
          className={SEGMENTED_GROUP_CLASS}
        >
          {MODES.map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => onModeChange(option)}
              aria-pressed={mode === option}
              className={segmentClass(mode === option)}
            >
              {t(`chart.modes.${option}` as Parameters<typeof t>[0])}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          {/* Walk the window through history without changing its length. Hidden
              for "All", which already shows everything. */}
          {isPannable && stepsAvailable > 0 && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setSpansBack((back) => Math.min(back + 1, stepsAvailable))}
                disabled={spansBack >= stepsAvailable}
                aria-label={t('chart.panEarlier')}
                title={t('chart.panEarlier')}
                className="rounded p-1 text-gray-500 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-700"
              >
                <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => setSpansBack((back) => Math.max(back - 1, 0))}
                disabled={spansBack === 0}
                aria-label={t('chart.panLater')}
                title={t('chart.panLater')}
                className="rounded p-1 text-gray-500 hover:bg-gray-100 disabled:cursor-not-allowed disabled:opacity-40 dark:text-gray-400 dark:hover:bg-gray-700"
              >
                <ChevronRightIcon className="h-4 w-4" aria-hidden="true" />
              </button>
            </div>
          )}
          <DateRangeSelector
            ranges={CHART_RANGES}
            value={dateRange}
            onChange={setDateRange}
            size="sm"
          />
        </div>
      </div>

      {/* The chart brings its own card chrome, loading skeleton and no-data
          state; this section only supplies the controls above it. */}
      <BalanceHistoryChart
        data={series}
        isLoading={isLoading}
        currencyCode={security.currencyCode}
        accountName={security.symbol}
        title={t(`chart.titles.${mode}` as Parameters<typeof t>[0])}
        // Marked on every series, including Return: knowing you bought into a
        // dip is exactly what the return line is read for.
        markers={markers}
        // On the value series a trade *changes* the line, so its marker belongs
        // on the first point that reflects it. Snapping backwards put a first
        // purchase on the day the position was still zero -- flat on the axis,
        // which read as the marker being missing altogether.
        markerSnap={mode === 'value' ? 'later' : 'earlier'}
        // The high/low bubbles sat beside the buy/sell dots in the same green and
        // red, and read as the price a trade went through at. The footer already
        // gives the first, latest and lowest figures.
        hideExtremeFlags
        neutralValues={mode !== 'return'}
        precise={mode === 'price'}
        valueFormat={mode === 'return' ? 'percent' : 'currency'}
        // None of these three series is a balance, so the footer must not call
        // its lowest point a "Min Balance".
        // Taller, so the two cards beside it have room without running past
        // the chart's bottom edge.
        plotHeight="tall"
        summaryLabels={{
          starting: t('chart.summary.first'),
          current: t('chart.summary.latest'),
          ending: t('chart.summary.ending'),
          lowest: t('chart.summary.lowest'),
        }}
      />
    </div>
  );
}
