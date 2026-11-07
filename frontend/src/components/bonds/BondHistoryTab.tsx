'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceDot,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartTooltip, type ChartTooltipEntry } from '@/components/reports/ChartTooltip';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { BondHistorySeriesTable } from './BondHistorySeriesTable';
import { useChartMonthFormat } from '@/hooks/useChartMonthFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useReportData } from '@/hooks/useReportData';
import { CHART_SERIES, chartColors } from '@/lib/chart-colors';
import { getErrorMessage } from '@/lib/errors';
import { investmentsApi } from '@/lib/investments';
import { buildHistoryPoints } from '@/lib/bond-offer';
import type { BondHistory } from '@/types/bond';
import { CHART_GRID_PROPS } from '@/lib/chart-style';
import { ChartActiveDot } from '@/components/ui/ChartActiveDot';

interface BondHistoryBodyProps {
  /** The issuing country of the bond's program; the history is read for it. */
  countryCode: string;
  program: string;
  /** The currency the product issues in; null when the catalog does not say. */
  currency: string | null;
  /**
   * Series codes the reader holds: marked on the rate chart with a reference
   * dot and highlighted in the table.
   */
  heldSeries?: readonly string[];
  /** Bumped by the page when a price refresh completes: re-reads in place. */
  refreshVersion?: number;
}

/**
 * One product's history: charts, the months the catalog lacks and the table of
 * every stored series. Used by the page of a program-linked security, with the
 * product fixed and the series held marked.
 */
export function BondHistoryBody({
  countryCode,
  program,
  currency,
  heldSeries = [],
  refreshVersion = 0,
}: BondHistoryBodyProps) {
  const t = useTranslations('bonds');
  const formatChartMonth = useChartMonthFormat();
  const { formatCurrency, formatCurrencyAxis, formatNumber, formatPercentTrimmed } =
    useNumberFormat();

  const requestKey = `${countryCode}|${program}`;
  const history = useReportData<BondHistory>(
    () => investmentsApi.getBondHistory(countryCode, program),
    [requestKey, refreshVersion],
    { requestKey },
  );
  // The payload belongs to the product it was asked for.
  const answer = useMemo(
    () =>
      history.data !== null && history.dataKey === requestKey
        ? (history.data.programs.find((p) => p.programCode === program) ?? {
            programCode: program,
            series: [],
            coverage: { from: null, to: null, missingMonths: [] },
          })
        : null,
    [history.data, history.dataKey, requestKey, program],
  );

  const points = useMemo(
    () => (answer === null ? [] : buildHistoryPoints(answer.series, answer.coverage)),
    [answer],
  );

  const feeText = (amount: number) =>
    currency === null ? formatNumber(amount) : formatCurrency(amount, currency);
  const feeAxis = (amount: number) =>
    currency === null ? formatNumber(amount) : formatCurrencyAxis(amount, currency);
  const hasFee = points.some((p) => p.fee !== null);
  const missing = answer?.coverage.missingMonths ?? [];

  const renderBody = () => {
    if (history.error) {
      return (
        <div role="alert" className="flex flex-wrap items-center gap-2">
          <p className="text-sm text-red-600 dark:text-red-400">
            {getErrorMessage(history.error, t('history.loadFailed'))}
          </p>
          <Button variant="outline" size="sm" onClick={history.reload}>
            {t('history.retry')}
          </Button>
        </div>
      );
    }
    if (answer === null) {
      return (
        <div className="flex justify-center py-8">
          <LoadingSpinner text={t('history.loading')} />
        </div>
      );
    }
    if (answer.series.length === 0) {
      return <EmptyState title={t('history.empty')} />;
    }
    const { coverage } = answer;
    const rateName = t('history.rate');
    const addendName = t('history.addend');
    const feeName = t('history.fee');
    return (
      <div className="space-y-6">
        {coverage.from !== null && coverage.to !== null && (
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t('history.coverage', {
              from: formatChartMonth(coverage.from),
              to: formatChartMonth(coverage.to),
            })}
          </p>
        )}

        <figure className="space-y-2">
          <figcaption className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('history.rateChartTitle')}
          </figcaption>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t('history.rateChartNote')}
          </p>
          <div role="img" aria-label={t('history.rateChartTitle')} className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <LineChart data={points} margin={{ left: 0, right: 8, top: 5, bottom: 0 }}>
                <CartesianGrid {...CHART_GRID_PROPS} />
                <XAxis
                  dataKey="month"
                  tickFormatter={(m: string) => formatChartMonth(m)}
                  tick={{ fill: chartColors.axis, fontSize: 11 }}
                  interval="preserveStartEnd"
                />
                <YAxis
                  tick={{ fill: chartColors.axis, fontSize: 11 }}
                  tickFormatter={(v: number) => formatPercentTrimmed(v)}
                  width="auto"
                  domain={['auto', 'auto']}
                />
                <Tooltip
                  content={({ active, payload, label }) => (
                    <ChartTooltip
                      active={active}
                      payload={payload as readonly ChartTooltipEntry[] | undefined}
                      label={formatChartMonth(String(label))}
                      formatValue={(v) => formatPercentTrimmed(v)}
                    />
                  )}
                />
                <Legend />
                {points
                  .filter((p) => p.rate !== null && heldSeries.includes(p.seriesCode ?? ''))
                  .map((p) => (
                    <ReferenceDot
                      key={p.month}
                      x={p.month}
                      y={p.rate as number}
                      r={7}
                      fill={chartColors.warning}
                      stroke={chartColors.surface}
                      strokeWidth={2}
                      ifOverflow="extendDomain"
                    />
                  ))}
                <Line
                  activeDot={ChartActiveDot}
                  type="monotone"
                  dataKey="rate"
                  name={rateName}
                  stroke={chartColors.primary}
                  strokeWidth={2}
                  dot
                  connectNulls={false}
                />
                <Line
                  activeDot={ChartActiveDot}
                  type="monotone"
                  dataKey="addend"
                  name={addendName}
                  stroke={CHART_SERIES[1]}
                  strokeWidth={2}
                  dot
                  connectNulls={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </figure>

        {hasFee && (
          <figure className="space-y-2">
            <figcaption className="text-sm font-semibold text-gray-900 dark:text-gray-100">
              {t('history.feeChartTitle')}
            </figcaption>
            <div role="img" aria-label={t('history.feeChartTitle')} className="h-56 w-full">
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <LineChart data={points} margin={{ left: 0, right: 8, top: 5, bottom: 0 }}>
                  <CartesianGrid {...CHART_GRID_PROPS} />
                  <XAxis
                    dataKey="month"
                    tickFormatter={(m: string) => formatChartMonth(m)}
                    tick={{ fill: chartColors.axis, fontSize: 11 }}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fill: chartColors.axis, fontSize: 11 }}
                    tickFormatter={feeAxis}
                    width="auto"
                    domain={[0, 'auto']}
                  />
                  <Tooltip
                    content={({ active, payload, label }) => (
                      <ChartTooltip
                        active={active}
                        payload={payload as readonly ChartTooltipEntry[] | undefined}
                        label={formatChartMonth(String(label))}
                        formatValue={feeText}
                      />
                    )}
                  />
                  <Line
                    activeDot={ChartActiveDot}
                    type="stepAfter"
                    dataKey="fee"
                    name={feeName}
                    stroke={CHART_SERIES[2]}
                    strokeWidth={2}
                    dot
                    connectNulls={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </figure>
        )}

        <div className="space-y-1">
          <p className="text-xs text-gray-500 dark:text-gray-400">{t('history.gapsNote')}</p>
          {missing.length > 0 ? (
            <div role="note">
              <h4 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {t('history.missingTitle', { count: missing.length })}
              </h4>
              <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-gray-600 dark:text-gray-400">
                {missing.map((month) => (
                  <li key={month}>{formatChartMonth(month)}</li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-gray-600 dark:text-gray-400">{t('history.noMissing')}</p>
          )}
        </div>

        <div>
          <h3 className="mb-2 text-sm font-semibold text-gray-900 dark:text-gray-100">
            {t('history.tableTitle')}
          </h3>
          <BondHistorySeriesTable
            series={answer.series}
            currency={currency}
            heldSeries={heldSeries}
          />
        </div>
      </div>
    );
  };

  return renderBody();
}
