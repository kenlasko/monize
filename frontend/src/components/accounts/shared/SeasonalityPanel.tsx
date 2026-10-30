'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { chartColors } from '@/lib/chart-colors';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import {
  computeSeasonality,
  MIN_YEARS_FOR_SEASONALITY,
} from '@/lib/payee-seasonality';
import type { DisplayCurrencyStrategy } from '@/components/transactions/widget-shared';
import type { MonthlyTotal } from '@/types/transaction';

interface SeasonalityPanelProps {
  /** The entity's whole monthly history. */
  monthly: MonthlyTotal[];
  currencyStrategy: DisplayCurrencyStrategy;
  isLoading: boolean;
  /**
   * The i18n namespace holding this panel's `seasonality.*` keys (`title`,
   * `tooltip`, `needsMoreHistory`, `even`, `peak`, `empty`, `monthTooltip`).
   * The payee and category detail pages each carry their own copy, so the
   * wording can name the entity ("this payee" vs "this category").
   */
  namespace: string;
}

/** All twelve calendar months, so a month with no history still gets a slot. */
const CALENDAR_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

/**
 * When in the year this entity costs money: a typical January beside a typical
 * December, averaged over every year of history.
 *
 * Twelve fixed slots, always in calendar order, because the shape of the year is
 * the point -- sorting by size or dropping the quiet months would destroy it. A
 * month with no history is drawn as an empty slot rather than omitted, so the
 * gaps are part of the picture.
 *
 * The headline only names a peak month when the data supports one (see
 * `computeSeasonality`): an evenly-billed payee still has a largest month, and
 * announcing that as a season would be inventing a pattern.
 */
export function SeasonalityPanel({
  monthly,
  currencyStrategy,
  isLoading,
  namespace,
}: SeasonalityPanelProps) {
  const t = useTranslations(namespace);
  const formatChartDate = useChartDateFormat();
  const { formatCurrency } = useNumberFormat();

  // The server names the currency its totals are in.
  const displayCurrency =
    monthly.find((r) => r.currency)?.currency ?? currencyStrategy.displayCurrency;

  const seasonality = useMemo(() => computeSeasonality(monthly), [monthly]);
  // The month whose figure the readout under the bars shows. A bar's figure
  // used to live in a hover-only `title`, which a phone and a keyboard never
  // reach; now pointing at, focusing or tapping a bar names it here.
  const [chosenMonth, setChosenMonth] = useState<number | null>(null);

  const byMonth = useMemo(
    () => new Map(seasonality.months.map((entry) => [entry.month, entry])),
    [seasonality.months],
  );

  const max = useMemo(
    () =>
      seasonality.months.reduce(
        (highest, entry) => Math.max(highest, Math.abs(entry.average)),
        0,
      ),
    [seasonality.months],
  );

  // A calendar month name in the user's locale, from a fixed non-leap year --
  // only the month is read off it.
  const monthName = (month: number) =>
    formatChartDate(`2001-${String(month).padStart(2, '0')}-01`, 'MMM');

  // The chosen month, or the peak until one is chosen; nothing while neither
  // has history to state.
  const readoutMonth = chosenMonth ?? seasonality.peakMonth;
  const readoutEntry = readoutMonth === null ? undefined : byMonth.get(readoutMonth);

  const headline = (() => {
    if (seasonality.yearsCovered < MIN_YEARS_FOR_SEASONALITY) {
      return t('seasonality.needsMoreHistory', {
        years: MIN_YEARS_FOR_SEASONALITY,
      });
    }
    if (seasonality.peakMonth === null) {
      return t('seasonality.even');
    }
    return t('seasonality.peak', { month: monthName(seasonality.peakMonth) });
  })();

  return (
    <section>
      <div className="mb-4 flex items-center">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('seasonality.title')}
        </h2>
        <InfoTooltip text={t('seasonality.tooltip')} usePortal />
      </div>
      <div className="rounded-lg bg-white p-4 shadow dark:bg-gray-800 dark:shadow-gray-700/50">
        {isLoading ? (
          <div className="h-40 animate-pulse rounded bg-gray-100 dark:bg-gray-700" />
        ) : max === 0 ? (
          <p className="py-4 text-center text-sm text-gray-500 dark:text-gray-400">
            {t('seasonality.empty')}
          </p>
        ) : (
          <>
            <p className="mb-4 text-sm text-gray-700 dark:text-gray-300">{headline}</p>
            {/* A row of twelve columns: bar above, month beneath. `items-end`
                grows every bar from a shared baseline so their heights compare. */}
            <ul className="flex items-end gap-1 sm:gap-2">
              {CALENDAR_MONTHS.map((month) => {
                const entry = byMonth.get(month);
                const average = entry?.average ?? 0;
                const height = max > 0 ? (Math.abs(average) / max) * 100 : 0;
                const isPeak = seasonality.peakMonth === month;
                const isChosen = (chosenMonth ?? seasonality.peakMonth) === month;
                return (
                  <li key={month} className="flex min-w-0 flex-1 flex-col items-center">
                    {/* Twelve inline amounts would not fit and the bar alone is
                        a shape, so each column is a button that puts its
                        figure in the readout below. */}
                    <button
                      type="button"
                      disabled={!entry}
                      aria-pressed={entry ? isChosen : undefined}
                      onClick={() => setChosenMonth(month)}
                      onFocus={() => setChosenMonth(month)}
                      onMouseEnter={() => entry && setChosenMonth(month)}
                      className="flex w-full flex-col items-center rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-default"
                    >
                    <div className="flex h-24 w-full items-end justify-center">
                      {entry ? (
                        <div
                          // The theme accent, matching TopGroupsPanel: a
                          // twelve-month shape is a magnitude comparison, not a
                          // warning, and red here would both fight the palette
                          // and borrow the emphasis the Monthly Totals chart
                          // needs. Inflow months keep green so the sign
                          // survives. The peak is the same token at full
                          // strength and the rest are washed back toward the
                          // card, so highlighting it costs neither the sign nor
                          // a colour of its own.
                          className="w-full rounded-t"
                          // A month with history but a zero average still shows
                          // a sliver, so it reads as "billed, netted out"
                          // rather than as a month with no history at all.
                          style={{
                            height: `${Math.max(height, 2)}%`,
                            backgroundColor:
                              average > 0 ? chartColors.income : chartColors.primary,
                            opacity: isPeak ? 1 : 0.6,
                          }}
                        />
                      ) : (
                        <div className="h-px w-full bg-gray-200 dark:bg-gray-700" />
                      )}
                    </div>
                    <span
                      className={`mt-1 truncate text-[10px] sm:text-xs ${
                        isPeak
                          ? 'font-semibold text-gray-900 dark:text-gray-100'
                          : 'text-gray-500 dark:text-gray-400'
                      }`}
                    >
                      {monthName(month)}
                    </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {readoutEntry && (
              <p
                aria-live="polite"
                data-testid="seasonality-readout"
                className="mt-3 text-sm text-gray-700 dark:text-gray-300"
              >
                {t('seasonality.monthTooltip', {
                  month: monthName(readoutEntry.month),
                  amount: formatCurrency(
                    Math.abs(readoutEntry.average),
                    displayCurrency,
                  ),
                  years: readoutEntry.years,
                })}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
