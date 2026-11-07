'use client';

import { useTranslations } from 'next-intl';
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  LabelList,
  Legend,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { AccountType } from '@/types/account';
import type { MonthlyNetWorth } from '@/types/net-worth';
import { chartColors } from '@/lib/chart-colors';
import {
  NET_WORTH_LINE_COLOR,
  netWorthAccountTypeColor,
  netWorthAccountTypes,
  netWorthStackTop,
} from '@/lib/net-worth-account-types';
import { ChartTooltipPanel } from '@/components/reports/ChartTooltip';
import { CHART_GRID_PROPS } from '@/lib/chart-style';
import { ChartActiveDot } from '@/components/ui/ChartActiveDot';

/**
 * How the bars are drawn: one solid bar of net worth a month, or stacked by
 * the account types that make it up.
 */
export type NetWorthBarStyle = 'netWorth' | 'accountType';

/** One month as the chart draws it. */
export interface NetWorthByAccountTypePoint {
  /** The x-axis category: stable and locale-independent. */
  key: string;
  /** The month as the tooltip names it. */
  name: string;
  /**
   * `null` is a month the server could not fully convert: its figure would be a
   * subtotal, so it draws no bar and no point rather than a measured dip. Such
   * a month carries no `byAccountType` either.
   */
  netWorth: number | null;
  byAccountType?: MonthlyNetWorth['byAccountType'];
}

interface NetWorthByAccountTypeChartProps {
  data: readonly NetWorthByAccountTypePoint[];
  /** Default `accountType`. */
  barStyle?: NetWorthBarStyle;
  formatCurrency: (value: number) => string;
  /** The x-axis tick label for a point's `key`. */
  formatXTick: (key: string) => string;
  /** Explicit x-axis ticks, where the caller thins them. */
  xTicks?: string[];
  /** Draws a y-axis with these labels; the axis is hidden without it. */
  formatYTick?: (value: number) => string;
  /**
   * Tick size; a caller that sets it (the compact dashboard widget) gets the
   * legend at the same size. Without it the report draws the default legend.
   */
  fontSize?: number;
  margin?: { top: number; right: number; left: number; bottom: number };
  /** Each month's net worth printed above its bar, upright or rotated. */
  valueLabels?: 'horizontal' | 'vertical';
  formatValueLabel?: (value: number) => string;
}

interface TooltipBodyProps {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: unknown }>;
  types: readonly AccountType[];
  typeLabel: (type: AccountType) => string;
  netWorthLabel: string;
  /** Why a month with no figure has none. */
  withheldLabel: string;
  formatCurrency: (value: number) => string;
}

/** The month's net worth and what each account type in it contributes. */
function NetWorthByAccountTypeTooltip({
  active,
  payload,
  types,
  typeLabel,
  netWorthLabel,
  withheldLabel,
  formatCurrency,
}: TooltipBodyProps) {
  const point = active ? (payload?.[0]?.payload as NetWorthByAccountTypePoint | undefined) : undefined;
  if (!point) return null;
  if (point.netWorth === null) {
    return (
      <ChartTooltipPanel>
        <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">{point.name}</p>
        <p className="text-sm text-gray-600 dark:text-gray-400 max-w-56">{withheldLabel}</p>
      </ChartTooltipPanel>
    );
  }
  // Only what the month holds: a type at zero this month contributes nothing.
  const rows = types.filter((type) => {
    const value = point.byAccountType?.[type];
    return value !== undefined && value !== 0;
  });
  return (
    <ChartTooltipPanel>
      <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">{point.name}</p>
      {rows.map((type) => (
        <p key={type} className="flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300">
          <span
            aria-hidden
            className="h-2.5 w-2.5 flex-shrink-0 rounded-sm"
            style={{ backgroundColor: netWorthAccountTypeColor(type) }}
          />
          <span>{typeLabel(type)}</span>
          <span className="ml-auto pl-4 tabular-nums">{formatCurrency(point.byAccountType![type]!)}</span>
        </p>
      ))}
      <p
        className={`flex items-center gap-2 text-sm font-medium text-gray-900 dark:text-gray-100 ${
          rows.length > 0 ? 'mt-1 pt-1 border-t border-gray-100 dark:border-gray-700' : ''
        }`}
      >
        <span>{netWorthLabel}</span>
        <span className="ml-auto pl-4 tabular-nums">{formatCurrency(point.netWorth)}</span>
      </p>
    </ChartTooltipPanel>
  );
}

/**
 * Net worth month by month as bars, in one of two styles. Stacked by account
 * type, what is held stacks up from zero and what is owed down from it, each
 * type in its own colour, with net worth itself drawn as a line across them.
 * Solid, each month is one bar of net worth in the theme accent. Shared by the
 * Net Worth Over Time report and the dashboard widget.
 *
 * Every figure is the server's (`MonthlyNetWorth.byAccountType`). A response
 * without the breakdown (an older backend mid-deploy) draws the solid bars.
 */
export function NetWorthByAccountTypeChart({
  data,
  barStyle = 'accountType',
  formatCurrency,
  formatXTick,
  xTicks,
  formatYTick,
  fontSize,
  margin = { top: 10, right: 10, left: 0, bottom: 0 },
  valueLabels,
  formatValueLabel = formatCurrency,
}: NetWorthByAccountTypeChartProps) {
  const t = useTranslations('reports');
  const tCommon = useTranslations('common');
  // The solid style is the chart with no types to stack.
  const types = barStyle === 'accountType' ? netWorthAccountTypes(data) : [];
  const typeLabel = (type: AccountType) => tCommon(`accountTypes.${type}`);
  const netWorthLabel = t('netWorth.seriesNetWorth');

  return (
    <ResponsiveContainer width="100%" height="100%" minWidth={0}>
      <ComposedChart data={data as NetWorthByAccountTypePoint[]} stackOffset="sign" margin={margin}>
        <CartesianGrid {...CHART_GRID_PROPS} />
        <XAxis
          dataKey="key"
          tick={{ fill: chartColors.axis, fontSize: fontSize ?? 12 }}
          tickLine={false}
          {...(xTicks ? { ticks: xTicks } : { interval: 'preserveStartEnd' as const })}
          tickFormatter={formatXTick}
        />
        <YAxis
          hide={!formatYTick}
          tickFormatter={formatYTick}
          tick={{ fill: chartColors.axis, fontSize: fontSize ?? 12 }}
        />
        <Tooltip
          content={
            <NetWorthByAccountTypeTooltip
              types={types}
              typeLabel={typeLabel}
              netWorthLabel={netWorthLabel}
              withheldLabel={t('netWorth.partialMonth')}
              formatCurrency={formatCurrency}
            />
          }
          cursor={{ fill: chartColors.grid, fillOpacity: 0.35 }}
        />
        <Legend wrapperStyle={fontSize === undefined ? undefined : { fontSize }} />
        <ReferenceLine y={0} stroke={chartColors.axis} strokeDasharray="3 3" />
        {types.map((type) => (
          <Bar
            key={type}
            dataKey={(point: NetWorthByAccountTypePoint) => point.byAccountType?.[type]}
            stackId="net-worth"
            name={typeLabel(type)}
            fill={netWorthAccountTypeColor(type)}
            // A hairline of the card between segments: neighbouring steps of
            // one ramp are close in colour, and the gap keeps them apart.
            stroke={chartColors.surface}
            strokeWidth={1}
          />
        ))}
        {types.length === 0 && (
          <Bar dataKey="netWorth" name={netWorthLabel} fill={chartColors.primary} radius={[4, 4, 0, 0]} />
        )}
        {types.length > 0 && (
          <Line
            activeDot={ChartActiveDot}
            dataKey="netWorth"
            name={netWorthLabel}
            stroke={NET_WORTH_LINE_COLOR}
            strokeWidth={2}
            dot={{ r: 3, fill: NET_WORTH_LINE_COLOR, stroke: chartColors.surface, strokeWidth: 1 }}
            isAnimationActive={false}
          />
        )}
        {valueLabels && (
          // Invisible: it only carries the labels to the top of each bar,
          // where net worth is printed whatever the bar is made of.
          <Line
            dataKey={(point: NetWorthByAccountTypePoint) =>
              point.netWorth === null
                ? null
                : types.length === 0
                  ? point.netWorth
                  : netWorthStackTop({ ...point, netWorth: point.netWorth })
            }
            stroke="none"
            dot={false}
            activeDot={false}
            legendType="none"
            tooltipType="none"
            isAnimationActive={false}
          >
            <LabelList
              dataKey="netWorth"
              position="top"
              angle={valueLabels === 'vertical' ? -90 : 0}
              offset={valueLabels === 'vertical' ? 6 : 5}
              textAnchor={valueLabels === 'vertical' ? 'start' : 'middle'}
              // A withheld month has no figure to label: `Number(null)` would
              // print a measured zero above the gap.
              formatter={(value: unknown) =>
                value === null || value === undefined ? '' : formatValueLabel(Number(value))
              }
              style={{
                fill: chartColors.axis,
                fontSize: 11,
                fontWeight: 600,
                ...(valueLabels === 'vertical' && { dominantBaseline: 'central' as const }),
              }}
            />
          </Line>
        )}
      </ComposedChart>
    </ResponsiveContainer>
  );
}
