'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { useReportData } from '@/hooks/useReportData';
import { investmentsApi } from '@/lib/investments';
import { Security, SecurityPrice } from '@/types/investment';
import { chartColors, chartSeriesColor } from '@/lib/chart-colors';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { parseLocalDate, type ChartDatePattern } from '@/lib/utils';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { buildTimeAxisTicks } from '@/lib/chart-time-axis';

// Match the single-security price chart's window (~3 years of history).
const PRICE_LIMIT = 1095;

/** A security plotted as one line, with its assigned palette colour. */
export interface PerformanceSeries {
  id: string;
  symbol: string;
  name: string;
  color: string;
}

/** One merged row: a timestamp plus each security's % return (by id). */
export interface PerformanceRow {
  ts: number;
  [securityId: string]: number;
}

/**
 * Normalise each security's price history to its own cumulative percent return
 * (rebased to 0% at that security's first available price in the window) and
 * merge into one date-keyed dataset. Rebasing per security -- rather than
 * plotting raw prices -- is what lets securities with different price levels and
 * currencies be compared on a single axis. A security with no usable price (none
 * in the window, or a non-positive base) is dropped from the legend rather than
 * drawn as a flat zero line.
 */
export function buildPerformanceData(
  input: { security: Security; prices: SecurityPrice[] }[],
): { rows: PerformanceRow[]; series: Omit<PerformanceSeries, 'color'>[] } {
  const byTs = new Map<number, PerformanceRow>();
  const series: Omit<PerformanceSeries, 'color'>[] = [];

  for (const { security, prices } of input) {
    const sorted = [...prices].sort((a, b) =>
      a.priceDate.localeCompare(b.priceDate),
    );
    const base = sorted.length > 0 ? Number(sorted[0].closePrice) : 0;
    if (!(base > 0)) continue;

    series.push({ id: security.id, symbol: security.symbol, name: security.name });

    for (const p of sorted) {
      const ts = parseLocalDate(p.priceDate).getTime();
      const pct = (Number(p.closePrice) / base - 1) * 100;
      const row = byTs.get(ts) ?? { ts };
      row[security.id] = pct;
      byTs.set(ts, row);
    }
  }

  const rows = [...byTs.values()].sort((a, b) => a.ts - b.ts);
  return { rows, series };
}

interface AllSecuritiesChartProps {
  securities: Security[];
  /** Bumped by the RefreshPricesButton so a manual price refresh re-fetches. */
  reloadKey?: number;
}

/**
 * Performance-comparison view for the Security Performance report: every active
 * security drawn on one chart as its cumulative percent return over time, so the
 * user can see at a glance which holdings have out- or under-performed. Mounted
 * only when the "All securities" option is selected, so its per-security price
 * fetches do not run for the normal single-security flow.
 */
export function AllSecuritiesChart({
  securities,
  reloadKey = 0,
}: AllSecuritiesChartProps) {
  const t = useTranslations('reports');
  const formatChartDate = useChartDateFormat();
  const { formatSignedPercent } = useNumberFormat();

  const { data, isLoading, error } = useReportData(async () => {
    const results = await Promise.all(
      securities.map(async (security) => ({
        security,
        prices: await investmentsApi.getSecurityPrices(security.id, PRICE_LIMIT),
      })),
    );
    return buildPerformanceData(results);
  }, [securities, reloadKey]);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const series = useMemo<PerformanceSeries[]>(
    () =>
      (data?.series ?? [])
        .slice()
        .sort((a, b) => a.symbol.localeCompare(b.symbol))
        .map((s, i) => ({ ...s, color: chartSeriesColor(i) })),
    [data],
  );
  const symbolById = useMemo(() => {
    const map = new Map<string, string>();
    series.forEach((s) => map.set(s.id, s.symbol));
    return map;
  }, [series]);

  const xAxis = useMemo(() => {
    if (rows.length === 0) {
      return {
        ticks: [] as number[],
        domain: ['dataMin', 'dataMax'] as [string, string],
        tickFormat: 'MMM yyyy' as ChartDatePattern,
      };
    }
    const minTs = rows[0].ts;
    const maxTs = rows[rows.length - 1].ts;
    const { ticks, stepMonths } = buildTimeAxisTicks(minTs, maxTs);
    return {
      ticks,
      domain: [minTs, maxTs] as [number, number],
      tickFormat: (stepMonths >= 12 ? 'yyyy' : 'MMM yyyy') as ChartDatePattern,
    };
  }, [rows]);

  if (error) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-8 text-center">
        <p className="text-gray-500 dark:text-gray-400">
          {t('securityPerformance.allSecuritiesError')}
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 px-2 py-4 sm:p-6">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
        {t('securityPerformance.allSecuritiesTitle')}
      </h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        {t('securityPerformance.allSecuritiesSubtitle')}
      </p>

      {isLoading ? (
        <Skeleton className="h-80 w-full" />
      ) : series.length === 0 ? (
        <p className="text-gray-500 dark:text-gray-400 text-center py-8">
          {t('securityPerformance.allSecuritiesNoData')}
        </p>
      ) : (
        <div className="h-96">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <LineChart data={rows}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
              <XAxis
                dataKey="ts"
                type="number"
                scale="time"
                domain={xAxis.domain}
                ticks={xAxis.ticks}
                tickFormatter={(ts: number) =>
                  formatChartDate(new Date(ts), xAxis.tickFormat)
                }
                tick={{ fontSize: 11 }}
              />
              <YAxis
                tickFormatter={(v: number) => formatSignedPercent(v)}
                domain={['auto', 'auto']}
                tick={{ fontSize: 11 }}
              />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const ts = (payload[0].payload as PerformanceRow).ts;
                  const items = payload
                    .filter((p) => typeof p.value === 'number')
                    .map((p) => ({
                      id: String(p.dataKey),
                      symbol: symbolById.get(String(p.dataKey)) ?? '',
                      value: p.value as number,
                      color: p.color as string,
                    }))
                    .sort((a, b) => b.value - a.value);
                  return (
                    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3 max-h-64 overflow-y-auto">
                      <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">
                        {formatChartDate(new Date(ts), 'MMM d, yyyy')}
                      </p>
                      {items.map((item) => (
                        <p key={item.id} className="text-sm flex justify-between gap-3">
                          <span style={{ color: item.color }}>{item.symbol}</span>
                          <span className="text-gray-700 dark:text-gray-300">
                            {formatSignedPercent(item.value)}
                          </span>
                        </p>
                      ))}
                    </div>
                  );
                }}
              />
              <Legend />
              {series.map((s) => (
                <Line
                  key={s.id}
                  type="monotone"
                  dataKey={s.id}
                  name={s.symbol}
                  stroke={s.color}
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
