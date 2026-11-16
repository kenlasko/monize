'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Card } from '@/components/ui/Card';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useDateRange } from '@/hooks/useDateRange';
import {
  rateRowsInWindow,
  type RateHistoryRow,
  type RateSourceFilter,
} from '@/lib/currency-detail';
import { CurrencyPeriodSummary } from './CurrencyPeriodSummary';
import { CurrencyRateChart, CurrencyRateChartSkeleton } from './CurrencyRateChart';
import { CurrencyRateTable } from './CurrencyRateTable';

interface CurrencyRateHistorySectionProps {
  code: string;
  defaultCurrency: string;
  /** Every rate row, or `null` while the history loads. */
  rows: readonly RateHistoryRow[] | null;
  /** Lines under the table saying what a bounded read left out. */
  notes?: readonly string[];
}

/**
 * The chart, the period's figures and the table, over one selected period:
 * the chart's preset decides which rows all three show, so the table never
 * lists dates the chart has left out. The preset is remembered per currency;
 * the page keys this section by code, so switching currencies reads the new
 * one's.
 */
export function CurrencyRateHistorySection({
  code,
  defaultCurrency,
  rows,
  notes = [],
}: CurrencyRateHistorySectionProps) {
  const t = useTranslations('currencyDetail');
  const { dateRange, setDateRange, resolvedRange } = useDateRange({
    defaultRange: '1y',
    storageKey: `currencyDetail:range:${code}`,
  });
  const { start, end } = resolvedRange;
  // Kept here, not in the table: the table unmounts while a fill's re-read
  // is in flight, and the reader's chosen source must survive that.
  const [sourceFilter, setSourceFilter] = useState<RateSourceFilter>('all');

  const periodRows = useMemo(
    () => (rows ? rateRowsInWindow(rows, start, end) : null),
    [rows, start, end],
  );

  return (
    <>
      {periodRows ? (
        <>
          <CurrencyRateChart
            code={code}
            defaultCurrency={defaultCurrency}
            rows={periodRows}
            dateRange={dateRange}
            onDateRangeChange={setDateRange}
          />
          <CurrencyPeriodSummary code={code} defaultCurrency={defaultCurrency} rows={periodRows} />
        </>
      ) : (
        <CurrencyRateChartSkeleton />
      )}

      <section aria-labelledby="currency-rate-history-heading">
        <h2
          id="currency-rate-history-heading"
          className="mb-3 text-lg font-semibold text-gray-900 dark:text-gray-100"
        >
          {t('table.title')}
        </h2>
        {periodRows && rows ? (
          <CurrencyRateTable
            code={code}
            defaultCurrency={defaultCurrency}
            rows={periodRows}
            hasAnyRates={rows.length > 0}
            notes={notes}
            filter={sourceFilter}
            onFilterChange={setSourceFilter}
          />
        ) : (
          <Card padding="md">
            <LoadingSpinner text={t('table.loading')} />
          </Card>
        )}
      </section>
    </>
  );
}
