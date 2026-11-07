"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { chartColors } from "@/lib/chart-colors";
import { buildTimeAxisTicks } from "@/lib/chart-time-axis";
import { useChartDateFormat } from "@/hooks/useChartDateFormat";
import { useNumberFormat } from "@/hooks/useNumberFormat";
import { Skeleton } from "@/components/ui/LoadingSkeleton";
import { ChartTooltipPanel } from "@/components/reports/ChartTooltip";
import { type ChartDatePattern } from "@/lib/utils";
import {
  GemAssetRef,
  GemAssetRole,
  GemPerformance,
  GemRange,
} from "@/types/gem-strategy";
import {
  GEM_PORTFOLIO_SERIES,
  GEM_RANGES,
  GEM_ROLE_COLOURS,
  buildPerformanceRows,
  isKnown,
  lastKnownIndex,
  rolesWithData,
  performanceDomain,
  type GemPerformanceRow,
} from "@/lib/gem-strategy-view";
import { GemCard, GemEmptyState, GemSwatch, GemUnknown } from "./GemPrimitives";
import { useDateFormat } from "@/hooks/useDateFormat";
import { useGemLabels } from "./useGemLabels";
import { cn } from "@/lib/utils";
import { CHART_GRID_PROPS } from '@/lib/chart-style';
import { ChartActiveDot } from '@/components/ui/ChartActiveDot';

/**
 * The subset of Recharts' label-render props the end-of-line label needs. Typed
 * loosely (x/y/value arrive as string or number) so it stays assignable to the
 * `label` render contract.
 */
interface GemEndLabelProps {
  x?: string | number;
  y?: string | number;
  value?: string | number | boolean | null;
  index?: number;
}

interface GemPerformanceChartProps {
  performance: GemPerformance | null;
  /** Instruments per role, for legend labels. */
  assets: GemAssetRef[];
  /** Role the current signal allocates to -- drawn emphasised. */
  winnerRole: GemAssetRole | null;
  range: GemRange;
  onRangeChange: (range: GemRange) => void;
  /** True while a range change is in flight. */
  isLoading: boolean;
}

/**
 * Question 2, part one: how the strategy's assets have actually performed. One
 * cumulative-return line per asset with a zero baseline, the end value labelled
 * at the end of each line, and the signal's winner emphasised. Every other line
 * stays fully opaque -- the winner is distinguished by stroke weight, not by
 * fading the rest out.
 */
export function GemPerformanceChart({
  performance,
  assets,
  winnerRole,
  range,
  onRangeChange,
  isLoading,
}: GemPerformanceChartProps) {
  const t = useTranslations("strategies");
  const { roleLabel } = useGemLabels();
  const formatChartDate = useChartDateFormat();
  const { formatDate } = useDateFormat();
  const { formatSignedPercent } = useNumberFormat();
  const [legendOpen, setLegendOpen] = useState(false);

  const rows = useMemo(() => buildPerformanceRows(performance), [performance]);
  const roles = useMemo(() => rolesWithData(performance), [performance]);
  const domain = useMemo(() => performanceDomain(performance), [performance]);
  /** The simulation, when there is a line to draw. */
  const simulated =
    performance?.currentPortfolio &&
    performance.currentPortfolio.unavailableReason === null
      ? performance.currentPortfolio
      : null;
  /** Why there is not one, when the accounts hold something. */
  const unavailableSimulation =
    performance?.currentPortfolio?.unavailableReason ?? null;

  const symbolByRole = useMemo(
    () => new Map(assets.map((asset) => [asset.role, asset.symbol])),
    [assets],
  );

  const xAxis = useMemo(() => {
    if (rows.length === 0) {
      return {
        ticks: [] as number[],
        domain: ["dataMin", "dataMax"] as [string, string],
        tickFormat: "MMM yyyy" as ChartDatePattern,
      };
    }
    const minTs = rows[0].ts;
    const maxTs = rows[rows.length - 1].ts;
    const { ticks, stepMonths } = buildTimeAxisTicks(minTs, maxTs);
    return {
      ticks,
      domain: [minTs, maxTs] as [number, number],
      tickFormat: (stepMonths >= 12 ? "yyyy" : "MMM yyyy") as ChartDatePattern,
    };
  }, [rows]);

  const seriesLabel = (role: GemAssetRole): string => {
    const symbol = symbolByRole.get(role);
    return symbol ? `${roleLabel(role)} (${symbol})` : roleLabel(role);
  };

  const rangeSwitcher = (
    <div
      role="group"
      aria-label={t("gem.chart.rangeAriaLabel")}
      className="flex flex-wrap gap-1"
    >
      {GEM_RANGES.map((option) => {
        const isActive = option === range;
        return (
          <button
            key={option}
            type="button"
            aria-pressed={isActive}
            onClick={() => onRangeChange(option)}
            className={cn(
              "rounded px-2 py-1 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800",
              isActive
                ? "bg-blue-600 text-white dark:bg-blue-500"
                : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300 dark:hover:bg-gray-600",
            )}
          >
            {t(`gem.chart.ranges.${option}` as Parameters<typeof t>[0])}
          </button>
        );
      })}
    </div>
  );

  return (
    <GemCard
      title={t("gem.chart.title", {
        window: t(`gem.chart.windows.${range}` as Parameters<typeof t>[0]),
      })}
      hint={t("gem.chart.hint")}
      headerRight={rangeSwitcher}
      ariaLabel={t("gem.chart.title", {
        window: t(`gem.chart.windows.${range}` as Parameters<typeof t>[0]),
      })}
    >
      {/* Legend above the chart; collapsible on narrow screens. */}
      <button
        type="button"
        onClick={() => setLegendOpen((open) => !open)}
        aria-expanded={legendOpen}
        aria-controls="gem-chart-legend"
        className="mb-2 inline-flex items-center gap-1 text-xs font-medium text-blue-600 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 sm:hidden dark:text-blue-400"
      >
        {legendOpen ? t("gem.chart.hideLegend") : t("gem.chart.showLegend")}
      </button>
      <ul
        id="gem-chart-legend"
        className={cn(
          "mb-2 flex-wrap gap-x-4 gap-y-1 text-xs",
          legendOpen ? "flex" : "hidden",
          "sm:flex",
        )}
      >
        {roles.map((role) => (
          <li key={role} className="flex items-center gap-1.5">
            <GemSwatch colour={GEM_ROLE_COLOURS[role]} />
            <span
              className={cn(
                "text-gray-600 dark:text-gray-300",
                role === winnerRole &&
                  "font-semibold text-gray-900 dark:text-gray-100",
              )}
            >
              {seriesLabel(role)}
              {role === winnerRole && (
                <span className="ml-1 font-medium text-gray-500 dark:text-gray-400">
                  {t("gem.chart.winnerMarker")}
                </span>
              )}
            </span>
          </li>
        ))}
        {/* The simulation belongs in the key too. It is a line on the same
            chart, and one drawn in a colour and a dash the legend never
            explained -- so the only way to learn what it was involved reading
            the note under the chart, if it was noticed at all. */}
        {simulated && (
          <li className="flex items-center gap-1.5">
            <GemSwatch colour={chartColors.neutral} dashed />
            <span className="text-gray-600 dark:text-gray-300">
              {t("gem.chart.currentPortfolio")}
            </span>
          </li>
        )}
      </ul>

      {isLoading ? (
        <Skeleton className="h-64 w-full sm:h-72" />
      ) : roles.length === 0 ? (
        <GemEmptyState
          title={t("gem.chart.noDataTitle")}
          description={t("gem.chart.noDataDescription")}
        />
      ) : (
        <>
          <div className="h-64 sm:h-72 xl:h-[19rem]">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <LineChart
                data={rows}
                margin={{ top: 8, right: 60, left: 0, bottom: 0 }}
              >
                <CartesianGrid {...CHART_GRID_PROPS} />
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
                  stroke={chartColors.axis}
                />
                <YAxis
                  domain={domain ?? ["auto", "auto"]}
                  tickFormatter={(value: number) =>
                    formatSignedPercent(value, 0)
                  }
                  tick={{ fontSize: 11 }}
                  stroke={chartColors.axis}
                  width={60}
                />
                {/* Zero baseline: the break-even line for a cumulative return. */}
                <ReferenceLine
                  y={0}
                  stroke={chartColors.axis}
                  strokeDasharray="4 4"
                />
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const row = payload[0].payload as GemPerformanceRow;
                    return (
                      <ChartTooltipPanel>
                        <p className="mb-1 font-medium text-gray-900 dark:text-gray-100">
                          {formatChartDate(new Date(row.ts), "MMM d, yyyy")}
                        </p>
                        {simulated && (
                          <p className="flex justify-between gap-4 text-sm">
                            <span style={{ color: chartColors.neutral }}>
                              {t("gem.chart.currentPortfolio")}
                            </span>
                            <span className="text-gray-700 dark:text-gray-300">
                              {isKnown(row[GEM_PORTFOLIO_SERIES]) ? (
                                formatSignedPercent(
                                  row[GEM_PORTFOLIO_SERIES] as number,
                                )
                              ) : (
                                <GemUnknown />
                              )}
                            </span>
                          </p>
                        )}
                        {roles.map((role) => (
                          <p
                            key={role}
                            className="flex justify-between gap-4 text-sm"
                          >
                            <span style={{ color: GEM_ROLE_COLOURS[role] }}>
                              {symbolByRole.get(role) ?? roleLabel(role)}
                            </span>
                            <span className="text-gray-700 dark:text-gray-300">
                              {isKnown(row[role]) ? (
                                formatSignedPercent(row[role] as number)
                              ) : (
                                <GemUnknown />
                              )}
                            </span>
                          </p>
                        ))}
                      </ChartTooltipPanel>
                    );
                  }}
                />
                {roles.map((role) => {
                  const endIndex = lastKnownIndex(rows, role);
                  const colour = GEM_ROLE_COLOURS[role];
                  return (
                    <Line
                      activeDot={ChartActiveDot}
                      key={role}
                      type="monotone"
                      dataKey={role}
                      name={seriesLabel(role)}
                      stroke={colour}
                      strokeWidth={role === winnerRole ? 3 : 1.75}
                      dot={false}
                      // A gap in the prices stays a gap in the line. Bridging
                      // it draws a straight segment through months nobody
                      // observed, indistinguishable from measured data, while
                      // the tooltip under the cursor calls the value unknown.
                      // The simulated line below always did this; the asset
                      // lines were the outlier.
                      connectNulls={false}
                      isAnimationActive={false}
                      label={(props: GemEndLabelProps) => {
                        const { index } = props;
                        const x = Number(props.x);
                        const y = Number(props.y);
                        const value = Number(props.value);
                        if (
                          index !== endIndex ||
                          !Number.isFinite(x) ||
                          !Number.isFinite(y) ||
                          !Number.isFinite(value)
                        ) {
                          return <g key={`${role}-${index}-empty`} />;
                        }
                        return (
                          <text
                            key={`${role}-${index}-label`}
                            x={x + 6}
                            y={y + 4}
                            fill={colour}
                            fontSize={11}
                            fontWeight={role === winnerRole ? 700 : 600}
                          >
                            {formatSignedPercent(value)}
                          </text>
                        );
                      }}
                    />
                  );
                })}
                {/* The simulation, drawn dashed and in the neutral token: it
                    is a hypothetical about today's mix, not one of the
                    strategy's assets, and it must not read as one. */}
                {simulated && (
                  <Line
                    activeDot={ChartActiveDot}
                    type="monotone"
                    dataKey={GEM_PORTFOLIO_SERIES}
                    name={t("gem.chart.currentPortfolio")}
                    stroke={chartColors.neutral}
                    strokeWidth={2}
                    strokeDasharray="5 3"
                    dot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
            {t("gem.chart.footnote")}
            {performance?.incomplete && ` ${t("gem.chart.incompleteHistory")}`}
          </p>
          {/* What the dashed line is, and everything it is not. Printed rather
              than tucked into a tooltip: a portfolio line beside the asset
              lines reads as "what I actually made" unless it says otherwise. */}
          {simulated && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t("gem.chart.currentPortfolioNote")}
              {!simulated.completeRange &&
                ` ${t("gem.chart.currentPortfolioLateStart")}`}
              {/* A line stopping mid-chart is fine; stopping without saying
                  why is not. The instrument is named because that is the thing
                  the user can act on -- refresh its prices and the line
                  reaches the end. */}
              {simulated.endsOn && simulated.stoppedBy.length > 0 && (
                <>
                  {" "}
                  {t("gem.chart.currentPortfolioEarlyEnd", {
                    date: formatDate(simulated.endsOn),
                    symbols: simulated.stoppedBy.join(", "),
                  })}
                </>
              )}
            </p>
          )}
          {unavailableSimulation && (
            <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">
              {t(
                `gem.chart.currentPortfolioUnavailable.${unavailableSimulation}` as Parameters<
                  typeof t
                >[0],
              )}
            </p>
          )}
        </>
      )}
    </GemCard>
  );
}
