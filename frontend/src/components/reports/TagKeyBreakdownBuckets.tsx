'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { parseISO } from 'date-fns';
import { Tabs, TabPanel } from '@/components/ui/Tabs';
import { Card } from '@/components/ui/Card';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { ChartTooltip } from '@/components/reports/ChartTooltip';
import { chartColors } from '@/lib/chart-colors';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { IncomeExpenseTagBucket } from '@/types/built-in-reports';
import { CHART_GRID_PROPS } from '@/lib/chart-style';

interface TagKeyBreakdownBucketsProps {
  /** The KEY the caller broke the report down by (e.g. "scope"), for the heading. */
  tagKey: string;
  /** Value buckets plus the reserved untagged bucket, in the order the server sent them. */
  buckets: IncomeExpenseTagBucket[];
  /** Currency every figure below is expressed in (the report's `currency`). */
  reportingCurrency: string;
  /** Namespaces this instance's tab ids from any sibling breakdown on the same page. */
  idPrefix: string;
  /**
   * The selected bucket's value, when the caller owns the selection (Income vs
   * Expenses, whose main chart follows the active tab). Omit for the
   * uncontrolled default, where this component keeps the selection itself.
   */
  activeValue?: string;
  /** Called with the new bucket value when a tab is chosen. */
  onActiveValueChange?: (value: string) => void;
}

function bucketTabLabel(bucket: IncomeExpenseTagBucket, untaggedLabel: string): string {
  return bucket.isUntagged ? untaggedLabel : bucket.value;
}

/**
 * The `tagKey`/`buckets` addition to Income vs Expenses and Cash Flow
 * (`docs/specs/report-tag-key-breakdown.md` section 6): one tab per
 * discovered value plus the reserved untagged bucket, each showing that
 * bucket's own income/expenses and its tagged transfer flows.
 *
 * Tagged flows (`taggedInflows`/`taggedOutflows`) are rendered as their own
 * card, in a colour pair (indigo) distinct from the green/red used for
 * income/expenses above -- INV-REPORT-003: a transfer is never income, and a
 * reader must never mistake one figure for the other.
 */
export function TagKeyBreakdownBuckets({
  tagKey,
  buckets,
  reportingCurrency,
  idPrefix,
  activeValue: controlledValue,
  onActiveValueChange,
}: TagKeyBreakdownBucketsProps) {
  const t = useTranslations('reports');
  const formatChartDate = useChartDateFormat();
  const { formatCurrencyCompact: formatCurrency, formatCurrencyAxis } = useNumberFormat();
  const untaggedLabel = t('tagBreakdown.untagged');
  const [uncontrolledValue, setUncontrolledValue] = useState(buckets[0]?.value ?? '');
  const isControlled = controlledValue !== undefined;
  const activeValue = isControlled ? controlledValue : uncontrolledValue;
  const setActiveValue = (value: string) => {
    if (!isControlled) setUncontrolledValue(value);
    onActiveValueChange?.(value);
  };
  const active = buckets.find((bucket) => bucket.value === activeValue) ?? buckets[0];

  if (!active) return null;

  const tabs = buckets.map((bucket) => ({
    key: bucket.value,
    label: bucketTabLabel(bucket, untaggedLabel),
  }));

  return (
    <Card padding="md" className="space-y-4">
      <div>
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          {t('tagBreakdown.label')} ({tagKey})
        </h3>
        {/* A row tagged with two values under this key counts toward both, so
            per-value shares can add up to more than 100% -- disclosed rather
            than silently summed into a misleading figure (spec section 1.1 B1). */}
        <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
          {t('tagBreakdown.sharesExceedNote')}
        </p>
      </div>

      <Tabs
        tabs={tabs}
        value={active.value}
        onChange={setActiveValue}
        idPrefix={idPrefix}
        ariaLabel={t('tagBreakdown.label')}
      />

      {buckets.map((bucket) => {
        const isActive = bucket.value === active.value;
        const completeness = {
          missingCurrencies: bucket.missingCurrencies,
          excludedCount: bucket.excludedCount,
        };
        const chartData = bucket.data.map((item) => ({
          name: item.period,
          fullName: formatChartDate(parseISO(item.periodStart), 'MMM yyyy'),
          Income: Math.round(item.income),
          Expenses: Math.round(item.expenses),
        }));

        return (
          <TabPanel
            key={bucket.value}
            idPrefix={idPrefix}
            tabKey={bucket.value}
            isActive={isActive}
            keepMounted
            className="space-y-4"
          >
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart data={chartData} margin={{ top: 20, right: 10, left: 0, bottom: 5 }}>
                  <CartesianGrid {...CHART_GRID_PROPS} />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 12 }}
                    tickFormatter={(value: string) => formatChartDate(`${value}-01`, 'MMM')}
                  />
                  <YAxis tickFormatter={formatCurrencyAxis} tick={{ fontSize: 12 }} />
                  <Tooltip content={<ChartTooltip formatValue={(v) => formatCurrency(v)} />} />
                  <Legend />
                  <ReferenceLine y={0} stroke={chartColors.axis} />
                  <Bar
                    dataKey="Income"
                    name={t('incomeVsExpenses.seriesIncome')}
                    fill={chartColors.income}
                    radius={[4, 4, 0, 0]}
                  />
                  <Bar
                    dataKey="Expenses"
                    name={t('incomeVsExpenses.seriesExpenses')}
                    fill={chartColors.expense}
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div className="bg-green-50 dark:bg-green-900/20 rounded-lg p-4 text-center">
                <div className="text-sm text-green-600 dark:text-green-400">
                  {t('incomeVsExpenses.totalIncome')}
                </div>
                <div className="text-xl font-bold text-green-700 dark:text-green-300">
                  <PartialTotal
                    total={{ value: bucket.totals.knownIncome, ...completeness }}
                    displayCurrency={reportingCurrency}
                  >
                    {formatCurrency(bucket.totals.knownIncome)}
                  </PartialTotal>
                </div>
              </div>
              <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-4 text-center">
                <div className="text-sm text-red-600 dark:text-red-400">
                  {t('incomeVsExpenses.totalExpenses')}
                </div>
                <div className="text-xl font-bold text-red-700 dark:text-red-300">
                  <PartialTotal
                    total={{ value: bucket.totals.knownExpenses, ...completeness }}
                    displayCurrency={reportingCurrency}
                  >
                    {formatCurrency(bucket.totals.knownExpenses)}
                  </PartialTotal>
                </div>
              </div>
              <div
                className={`rounded-lg p-4 text-center ${
                  bucket.totals.knownNet >= 0
                    ? 'bg-blue-50 dark:bg-blue-900/20'
                    : 'bg-orange-50 dark:bg-orange-900/20'
                }`}
              >
                <div
                  className={`text-sm ${
                    bucket.totals.knownNet >= 0
                      ? 'text-blue-600 dark:text-blue-400'
                      : 'text-orange-600 dark:text-orange-400'
                  }`}
                >
                  {t('incomeVsExpenses.totalSavings')}
                </div>
                <div
                  className={`text-xl font-bold ${
                    bucket.totals.knownNet >= 0
                      ? 'text-blue-700 dark:text-blue-300'
                      : 'text-orange-700 dark:text-orange-300'
                  }`}
                >
                  <PartialTotal
                    total={{ value: bucket.totals.knownNet, ...completeness }}
                    displayCurrency={reportingCurrency}
                  >
                    {formatCurrency(bucket.totals.knownNet)}
                  </PartialTotal>
                </div>
              </div>
            </div>

            {/* Tagged transfer flows: a distinct figure, never folded into
                income/expenses above (INV-REPORT-003) -- its own colour pair
                (indigo, not the green/red used for income/expenses) and its
                own card so a reader never mistakes a tagged transfer for
                income. */}
            <div
              data-testid="tagged-flows"
              className="rounded-lg border border-indigo-200 dark:border-indigo-800 bg-indigo-50 dark:bg-indigo-900/20 p-4"
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <div className="text-sm text-indigo-700 dark:text-indigo-300">
                    {t('tagBreakdown.inflows')}
                  </div>
                  <div className="text-lg font-bold text-indigo-800 dark:text-indigo-200">
                    <PartialTotal
                      total={{ value: bucket.taggedInflows, ...completeness }}
                      displayCurrency={reportingCurrency}
                    >
                      {formatCurrency(bucket.taggedInflows)}
                    </PartialTotal>
                  </div>
                </div>
                <div>
                  <div className="text-sm text-indigo-700 dark:text-indigo-300">
                    {t('tagBreakdown.outflows')}
                  </div>
                  <div className="text-lg font-bold text-indigo-800 dark:text-indigo-200">
                    <PartialTotal
                      total={{ value: bucket.taggedOutflows, ...completeness }}
                      displayCurrency={reportingCurrency}
                    >
                      {formatCurrency(bucket.taggedOutflows)}
                    </PartialTotal>
                  </div>
                </div>
              </div>
            </div>
          </TabPanel>
        );
      })}
    </Card>
  );
}
