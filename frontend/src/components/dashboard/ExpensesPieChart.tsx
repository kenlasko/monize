'use client';

import { useReportingBasis, useReportingRouter } from '@/components/reports/ReportingBasis';
import { useMemo, useState } from 'react';

import { useTranslations } from 'next-intl';
import { chartColors } from '@/lib/chart-colors';
import { Account } from '@/types/account';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { CategorySpendingItem } from '@/types/built-in-reports';
import { useNumberFormat, type NumberFormatters } from '@/hooks/useNumberFormat';
import { PartialTotal } from '@/components/ui/PartialTotal';
import type { ConvertedTotal } from '@/lib/currency-total';
import { HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import { useReportData } from '@/hooks/useReportData';
import { useWidgetConfig } from '@/hooks/useWidgetConfig';
import { resolveRangePreset } from '@/lib/date-range';
import { CHART_COLOURS } from '@/lib/chart-colours';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { WidgetCard, WidgetConfigRow, WidgetMessage } from './WidgetCard';
import { WidgetSegmentedControl } from './WidgetSegmentedControl';
import { DonutCalloutChart, DonutCalloutSlice, DonutCalloutViewHint } from './DonutCalloutChart';
import {
  EXPENSES_PIE_DEFAULT,
  SPENDING_RANGES,
  ExpensesPieConfig,
} from './widget-config';

const WIDGET_ID = 'expenses-pie';
/**
 * How many categories keep a slice of their own before the rest become Other,
 * per view: the legend lists eleven, the callout view boxes the top ten (plus
 * Other), which is what fits beside the donut.
 */
const MAX_SLICES: Record<ExpensesPieConfig['view'], number> = { legend: 11, callouts: 10 };

const nonInvestmentAccounts = (a: Account) => a.accountType !== 'INVESTMENT';

/** One category as the chart draws it. */
interface CategorySlice {
  id: string;
  name: string;
  value: number;
  colour: string;
  /** The slice merging the categories past the cut. */
  isOther?: boolean;
}

interface ExpensesPieChartProps {
  accounts: Account[];
  isLoading: boolean;
}

interface ExpensesPieTooltipProps {
  slice: { name: string; value: number };
  totalExpenses: number;
  formatCurrency: NumberFormatters['formatCurrency'];
  formatPercent: NumberFormatters['formatPercent'];
}

function ExpensesPieTooltip({ slice, totalExpenses, formatCurrency, formatPercent }: ExpensesPieTooltipProps) {
  const percentage = (slice.value / totalExpenses) * 100;
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
      <p className="font-medium text-gray-900 dark:text-gray-100">{slice.name}</p>
      <p className="text-gray-600 dark:text-gray-400">
        {formatCurrency(slice.value)} ({formatPercent(percentage, 1)})
      </p>
    </div>
  );
}

export function ExpensesPieChart({ accounts, isLoading }: ExpensesPieChartProps) {
  const basis = useReportingBasis();
  const t = useTranslations('dashboard');
  const router = useReportingRouter();
  const { formatCurrencyCompact: formatCurrency, formatCurrencyTight, formatPercent } = useNumberFormat();
  const { config, updateConfig } = useWidgetConfig<ExpensesPieConfig>(
    WIDGET_ID,
    EXPENSES_PIE_DEFAULT,
  );
  // Whether the Other slice is opened into the categories inside it. A view
  // state, not a setting: it belongs to this glance at the chart, so it is not
  // persisted and it closes whenever the data behind it changes.
  const [otherExpanded, setOtherExpanded] = useState(false);

  const { start, end } = useMemo(() => resolveRangePreset(config.range), [config.range]);
  const accountIdsKey = config.accountIds.join(',');

  /**
   * The breakdown comes from the Spending by Category report, which is the one
   * place that decides what counts as spending: VOID rows out, asset-category
   * accounts out, investment rows out by linkage rather than by account type
   * (INV-REPORT-001), refunds netted against the category they were filed
   * under. This widget drew its own breakdown from paged transactions under a
   * simpler set of rules and disagreed with the report about the same period.
   *
   * The widget's two settings are asked of the server rather than applied to
   * its answer: an account filter re-applied here would be a second definition
   * of which rows count, and a rollup re-derived here a second definition of
   * which category a spend belongs to.
   */
  const { data: response, isLoading: dataLoading } = useReportData(
    () =>
      builtInReportsApi.getSpendingByCategory({
        ...(basis ? {basis} : {}),
        startDate: start || undefined,
        endDate: end,
        accountIds: config.accountIds.length > 0 ? config.accountIds : undefined,
        rollupToParent: config.topLevelOnly,
      }),
    [start, end, accountIdsKey, config.topLevelOnly, basis],
    { requestKey: JSON.stringify([start, end, accountIdsKey, config.topLevelOnly, basis]), maskStaleData: true },
  );

  const view = config.view === 'callouts' ? 'callouts' : 'legend';
  const maxSlices = MAX_SLICES[view];

  const breakdown = useMemo(() => {
    // Already largest-first from the server, which also decides which
    // categories are net-spending at all.
    const rows = response?.data ?? [];
    let colourIndex = 0;
    const slices: CategorySlice[] = rows.map((item: CategorySpendingItem) => ({
      id: item.categoryId ?? '',
      name: item.categoryName,
      value: item.total,
      colour: item.color || CHART_COLOURS[colourIndex++ % CHART_COLOURS.length],
    }));

    const inOther = slices.slice(maxSlices);
    const otherTotal = inOther.reduce((sum, item) => sum + item.value, 0);
    const data =
      inOther.length > 0
        ? [
            ...slices.slice(0, maxSlices),
            {
              id: '',
              name: t('expensesPieChart.other'),
              value: otherTotal,
              colour: chartColors.neutral,
              isOther: true,
            },
          ]
        : slices;

    return { data, inOther };
  }, [response, t, maxSlices]);

  const chartData = breakdown.data;
  /**
   * What the slices add up to, and whether that is the whole story. The server
   * leaves a row it could not convert out of every figure and says so, so this
   * is a subtotal exactly when it says a row was excluded -- marked, never
   * presented as the total it is not.
   */
  const spendingTotal: ConvertedTotal = useMemo(
    () => ({
      value: response?.knownSpending ?? 0,
      missingCurrencies: response?.missingCurrencies ?? [],
      excludedCount: response?.excludedCount ?? 0,
    }),
    [response],
  );
  const totalExpenses = spendingTotal.value;
  const displayCurrency = response?.currency ?? '';
  // The categories merged into Other, listed only while the user has opened it.
  const otherCategories = breakdown.inOther;
  // Close the disclosure when the categories inside Other are no longer the ones
  // the user opened -- a different timeframe, account filter or rollup answers a
  // different question. Keyed on the identities themselves rather than on the
  // memo's object, which is a fresh reference whenever its inputs re-resolve.
  // The "info from a previous render" pattern, not a setState in an effect.
  const otherKey = otherCategories.map((item) => item.id || item.name).join('|');
  const [openedFor, setOpenedFor] = useState(otherKey);
  if (openedFor !== otherKey) {
    setOpenedFor(otherKey);
    if (otherExpanded) setOtherExpanded(false);
  }

  const handleCategoryClick = (categoryId: string) => {
    if (categoryId) {
      const params = new URLSearchParams({ categoryIds: categoryId });
      if (start) params.set('startDate', start);
      params.set('endDate', end);
      router.push(`/transactions?${params.toString()}`);
    }
  };


  // A slice with an id opens its transactions; Other has none, and opens into
  // the categories it merged instead of going nowhere. A slice with neither
  // (Uncategorized) is inert, so it is not offered as a button.
  const chartSlices: DonutCalloutSlice[] = chartData.map((item, index) => ({
    key: item.id || `${item.name}-${index}`,
    name: item.name,
    value: item.value,
    color: item.colour,
    onClick: item.id
      ? () => handleCategoryClick(item.id)
      : item.isOther
        ? () => setOtherExpanded((open) => !open)
        : undefined,
  }));

  const configControls = (
    <>
      <WidgetConfigRow label={t('widgets.timeframe')}>
        <DateRangeSelector
          ranges={SPENDING_RANGES}
          value={config.range}
          onChange={(range) => updateConfig({ range })}
          size="sm"
        />
      </WidgetConfigRow>
      <WidgetConfigRow label={t('widgets.accounts')}>
        <ReportAccountMultiSelect
          accounts={accounts}
          value={config.accountIds}
          onChange={(accountIds) => updateConfig({ accountIds })}
          filter={nonInvestmentAccounts}
          className="w-full"
        />
      </WidgetConfigRow>
      <WidgetConfigRow label={t('expensesPieChart.topLevelOnly')}>
        <div className="flex items-center gap-2">
          <ToggleSwitch
            checked={config.topLevelOnly}
            onChange={(topLevelOnly) => updateConfig({ topLevelOnly })}
            label={t('expensesPieChart.topLevelOnly')}
          />
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {t('expensesPieChart.topLevelOnlyHint')}
          </span>
        </div>
      </WidgetConfigRow>
      <WidgetConfigRow label={t('widgets.view')}>
        <WidgetSegmentedControl
          value={view}
          onChange={(next) => updateConfig({ view: next })}
          options={[
            { value: 'callouts', label: t('expensesPieChart.viewCallouts') },
            { value: 'legend', label: t('expensesPieChart.viewLegend') },
          ]}
        />
        <DonutCalloutViewHint />
      </WidgetConfigRow>
    </>
  );

  const loading = isLoading || dataLoading;

  return (
    <WidgetCard
      title={t('expensesPieChart.title')}
      titleHref="/reports/spending-by-category"
      widgetId={WIDGET_ID}
      configTitle={t('expensesPieChart.title')}
      configControls={configControls}
      headerRight={
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {t(`widgets.rangeLabels.${config.range}` as Parameters<typeof t>[0])}
        </span>
      }
    >
      {loading ? (
        <div className="h-64 flex items-center justify-center">
          <div className="animate-pulse w-48 h-48 rounded-full bg-gray-200 dark:bg-gray-700" />
        </div>
      ) : chartData.length === 0 ? (
        <WidgetMessage>{t('expensesPieChart.empty')}</WidgetMessage>
      ) : (
        <>
          <DonutCalloutChart
            slices={chartSlices}
            view={view}
            label={t('expensesPieChart.title')}
            formatValue={(value) => formatCurrency(value)}
            // One vertical column on a phone, three from `sm` up -- the desktop
            // density this legend carried before the mobile-first redesign.
            legendColumnsClassName="sm:grid-cols-3"
            legendRadii={{ inner: 50, outer: 80 }}
            legendAreaClassName="h-64"
            // The aggregate belongs in the donut's hole, not in a row beneath
            // the legend that a phone has to scroll to.
            center={{
              label: t('expensesPieChart.total'),
              value: (
                <PartialTotal total={spendingTotal} displayCurrency={displayCurrency}>
                  {formatCurrency(totalExpenses)}
                </PartialTotal>
              ),
              // The callout view's hole is the smallest; a six-figure total in
              // full would run onto the ring there.
              compactValue: (
                <PartialTotal total={spendingTotal} displayCurrency={displayCurrency}>
                  {formatCurrencyTight(totalExpenses)}
                </PartialTotal>
              ),
            }}
            renderTooltip={(slice) => (
              <ExpensesPieTooltip
                slice={slice}
                totalExpenses={totalExpenses}
                formatCurrency={formatCurrency}
                formatPercent={formatPercent}
              />
            )}
          />
          {otherExpanded && otherCategories.length > 0 && (
            // What Other merged, at the same precision as the slices above it.
            // The chart keeps eleven slices whatever happens here: turning a
            // long tail into twenty slivers would make the chart unreadable and
            // answer a different question from the one the user asked.
            <div className="mt-3 border-t border-gray-200 dark:border-gray-700 pt-3">
              <p className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-2">
                {t('expensesPieChart.insideOther', { count: otherCategories.length })}
              </p>
              <ul className="space-y-1">
                {otherCategories.map((item) => (
                  <li key={item.id || item.name}>
                    <button
                      type="button"
                      onClick={() => handleCategoryClick(item.id)}
                      disabled={!item.id}
                      className={`flex w-full items-center gap-2 rounded-sm px-1 py-0.5 text-sm text-left ${HOVER_ROW_ON_CARD} focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 disabled:cursor-default disabled:hover:bg-transparent dark:disabled:hover:bg-transparent`}
                    >
                      <span
                        aria-hidden
                        className="h-2.5 w-2.5 flex-shrink-0 rounded-sm"
                        style={{ backgroundColor: item.colour }}
                      />
                      <span className="truncate text-gray-600 dark:text-gray-300">
                        {item.name}
                      </span>
                      <span className="ml-auto flex-shrink-0 text-gray-900 dark:text-gray-100">
                        {formatCurrency(item.value)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </WidgetCard>
  );
}
