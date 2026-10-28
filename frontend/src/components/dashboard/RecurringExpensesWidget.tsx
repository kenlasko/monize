'use client';

import { CashReportingNotice } from '@/components/reports/ReportingBasis';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useReportData } from '@/hooks/useReportData';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { reportTotal } from '@/lib/currency-total';
import { useWidgetConfig } from '@/hooks/useWidgetConfig';
import { chartSeriesColor } from '@/lib/chart-colors';
import { RecurringExpenseItem } from '@/types/built-in-reports';
import { ChartTooltipPanel } from '@/components/reports/ChartTooltip';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { WidgetCard, WidgetConfigRow, WidgetMessage } from './WidgetCard';
import { WidgetSegmentedControl } from './WidgetSegmentedControl';
import { DonutCalloutChart, DonutCalloutSlice, DonutCalloutViewHint } from './DonutCalloutChart';
import { RECURRING_EXPENSES_DEFAULT, RECURRING_RANGES, RecurringConfig } from './widget-config';

const WIDGET_ID = 'recurring-expenses';
const MIN_OCCURRENCE_OPTIONS = [2, 3, 4, 5, 6];

type RecurringSlice = DonutCalloutSlice & { item: RecurringExpenseItem };

interface RecurringExpensesWidgetProps {
  isLoading: boolean;
}

export function RecurringExpensesWidget({ isLoading }: RecurringExpensesWidgetProps) {
  const t = useTranslations('dashboard');
  const router = useRouter();
  const { formatCurrency, formatCurrencyCompact, formatCurrencyTight, defaultCurrency } = useNumberFormat();
  const { config, updateConfig } = useWidgetConfig<RecurringConfig>(
    WIDGET_ID,
    RECURRING_EXPENSES_DEFAULT,
  );

  const { data: response, isLoading: dataLoading } = useReportData(
    () => builtInReportsApi.getRecurringExpenses(config.minOccurrences, config.range),
    [config.minOccurrences, config.range],
  );

  const chartData = useMemo<RecurringSlice[]>(
    () =>
      (response?.data ?? []).slice(0, 10).map((item, index) => {
        const payeeId = item.payeeId;
        return {
          key: payeeId || item.payeeName,
          name: item.payeeName,
          value: item.totalAmount,
          color: chartSeriesColor(index),
          onClick: payeeId ? () => router.push(`/transactions?payeeId=${payeeId}`) : undefined,
          item,
        };
      }),
    [response, router],
  );

  // `monthlyEstimate` is withheld when a row could not be converted; what is
  // shown is the part that did, marked as a subtotal.
  const estimate = reportTotal(
    response?.summary.monthlyEstimate ?? response?.summary.knownMonthlyEstimate ?? 0,
    response,
  );
  const monthlyEstimate = estimate.value;
  const reportingCurrency = response?.currency ?? defaultCurrency;

  const rangeLabel = (range: string) =>
    t(`widgets.rangeLabels.${range}` as Parameters<typeof t>[0]);

  const configControls = (
    <>
      <WidgetConfigRow label={t('widgets.timeframe')}>
        <DateRangeSelector
          ranges={RECURRING_RANGES}
          labels={Object.fromEntries(RECURRING_RANGES.map((r) => [r, rangeLabel(r)]))}
          value={config.range}
          onChange={(range) => updateConfig({ range: range as RecurringConfig['range'] })}
          size="sm"
        />
      </WidgetConfigRow>
      <WidgetConfigRow label={t('recurringExpenses.minOccurrences')}>
        <select
          value={config.minOccurrences}
          onChange={(e) => updateConfig({ minOccurrences: Number(e.target.value) })}
          className="w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 px-3 py-2 text-sm text-gray-900 dark:text-gray-100"
        >
          {MIN_OCCURRENCE_OPTIONS.map((n) => (
            <option key={n} value={n}>
              {t('recurringExpenses.minOccurrencesOption', { count: n })}
            </option>
          ))}
        </select>
      </WidgetConfigRow>
      <WidgetConfigRow label={t('widgets.view')}>
        <WidgetSegmentedControl
          value={config.view}
          onChange={(view) => updateConfig({ view })}
          options={[
            { value: 'callouts', label: t('recurringExpenses.viewCallouts') },
            { value: 'legend', label: t('recurringExpenses.viewLegend') },
          ]}
        />
        <DonutCalloutViewHint />
      </WidgetConfigRow>
    </>
  );

  const loading = isLoading || dataLoading;

  return (
    <WidgetCard
      title={t('recurringExpenses.title')}
      titleHref="/reports/recurring-expenses"
      widgetId={WIDGET_ID}
      headerRight={
        <span className="text-sm text-gray-500 dark:text-gray-400">{rangeLabel(config.range)}</span>
      }
      configControls={configControls}
      configTitle={t('recurringExpenses.title')}
    >
      <CashReportingNotice />
      {loading ? (
        <div className="flex-1 min-h-[260px] animate-pulse rounded-md bg-gray-100 dark:bg-gray-700/50" />
      ) : chartData.length === 0 ? (
        <WidgetMessage>{t('recurringExpenses.empty')}</WidgetMessage>
      ) : (
        <DonutCalloutChart
          slices={chartData}
          view={config.view}
          label={t('recurringExpenses.title')}
          formatValue={(value) => formatCurrencyCompact(value)}
          // The estimate is what the slices come to a month, so it belongs in
          // the donut's hole rather than in a row under the chart.
          center={{
            label: t('recurringExpenses.monthlyEstimate'),
            value: (
              <PartialTotal total={estimate} displayCurrency={reportingCurrency}>
                {formatCurrencyCompact(monthlyEstimate)}
              </PartialTotal>
            ),
            compactValue: (
              <PartialTotal total={estimate} displayCurrency={reportingCurrency}>
                {formatCurrencyTight(monthlyEstimate)}
              </PartialTotal>
            ),
          }}
          renderTooltip={(slice) => (
            <ChartTooltipPanel>
              <p className="font-medium text-gray-900 dark:text-gray-100">{slice.name}</p>
              <p className="text-gray-600 dark:text-gray-400">{formatCurrency(slice.value)}</p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {t('recurringExpenses.occurrences', { count: slice.item.occurrences })}
              </p>
            </ChartTooltipPanel>
          )}
        />
      )}
    </WidgetCard>
  );
}
