'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { chartColors, chartSeriesColor } from '@/lib/chart-colors';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';

export interface ScenarioOutcome {
  id: string;
  name: string;
  /** Extra paid on top of each installment; null when the scenario has none */
  recurringExtra: number | null;
  /** Number of one-time lump sums in the scenario */
  lumpSumCount: number;
  /** Interest saved vs the no-overpayment baseline */
  interestSaved: number;
  /** Projected payoff date (yyyy-MM-dd), or null when not paid off in range */
  payoffDate: string | null;
}

export interface BaselineOutcome {
  payoffDate: string | null;
}

interface ScenarioComparisonChartProps {
  outcomes: ScenarioOutcome[];
  baseline: BaselineOutcome;
  currencyCode: string;
}

const W = 920;
const H = 420;
const MARGIN = { top: 70, right: 30, bottom: 78, left: 80 };

/** Fractional year at the middle of the date's month, for smooth time scaling */
const toYear = (iso: string): number => {
  const d = new Date(iso);
  return d.getUTCFullYear() + (d.getUTCMonth() + 0.5) / 12;
};

/** Rounds up to a "nice" axis maximum (1/2/5 times a power of ten) */
const niceCeil = (value: number): number => {
  const pow = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 5, 10]) {
    if (value <= step * pow) return step * pow;
  }
  return 10 * pow;
};

/**
 * Compares saved overpayment scenarios as parabolic arcs on a shared
 * timeline. Each arc starts today and returns to the axis at its payoff date,
 * so the arc's span is the loan's remaining life; the apex height is the
 * interest saved vs the no-overpayment baseline (left axis); the extra paid
 * per installment is labelled at the apex, where geometry runs out. The
 * baseline is a flat dotted marker ending at the original payoff date.
 * Narrower and taller = better. Rendered only when more than one scenario is
 * saved.
 */
export function ScenarioComparisonChart({
  outcomes,
  baseline,
  currencyCode,
}: ScenarioComparisonChartProps) {
  const t = useTranslations('accounts');
  const formatChartDate = useChartDateFormat();
  const { formatCurrency, formatCurrencyAxis } = useNumberFormat();
  const [hoveredId, setHoveredId] = useState<string | null>(null);

  const now = new Date();
  const todayYear = now.getFullYear() + (now.getMonth() + 0.5) / 12;

  // Colors are assigned by saved order (entity, not rank); drawing goes
  // largest-savings first so smaller arcs and their labels stay on top.
  const series = outcomes.map((o, i) => ({ ...o, color: chartSeriesColor(i) }));
  const drawOrder = [...series].sort((a, b) => b.interestSaved - a.interestSaved);

  const payoffYears = [
    ...series.map((o) => (o.payoffDate ? toYear(o.payoffDate) : null)),
    baseline.payoffDate ? toYear(baseline.payoffDate) : null,
  ].filter((v): v is number => v !== null);
  const lastYear = Math.max(todayYear + 1, ...payoffYears);
  const xEnd = lastYear + (lastYear - todayYear) * 0.05;
  const yTop = niceCeil(Math.max(1, ...series.map((o) => o.interestSaved)));

  const x = (year: number) =>
    MARGIN.left + ((year - todayYear) / (xEnd - todayYear)) * (W - MARGIN.left - MARGIN.right);
  const y = (value: number) =>
    H - MARGIN.bottom - (value / yTop) * (H - MARGIN.top - MARGIN.bottom);
  const y0 = y(0);

  const yearTickStep = Math.max(1, Math.ceil((xEnd - todayYear) / 8));
  const yearTicks: number[] = [];
  for (let year = Math.ceil(todayYear); year <= Math.floor(xEnd); year += yearTickStep) {
    yearTicks.push(year);
  }
  const yTicks = [0.25, 0.5, 0.75, 1].map((f) => f * yTop);

  const payoffLabel = (payoffDate: string | null): string =>
    payoffDate
      ? formatChartDate(payoffDate, 'MMM yyyy')
      : t('loanDetail.comparison.beyondProjection');

  const overpaymentLabel = (o: ScenarioOutcome): string => {
    const parts: string[] = [];
    if (o.recurringExtra && o.recurringExtra > 0) {
      parts.push(
        t('loanDetail.scenarioChart.extraShort', {
          amount: formatCurrency(o.recurringExtra, currencyCode),
        }),
      );
    }
    if (o.lumpSumCount > 0) {
      parts.push(t('loanDetail.scenarios.lumpSumSummary', { count: o.lumpSumCount }));
    }
    return parts.join(' + ') || t('loanDetail.scenarios.emptyScenario');
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">
        {t('loanDetail.scenarioChart.title')}
      </h3>
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
        {t('loanDetail.scenarioChart.description')}
      </p>
      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="block min-w-[40rem] w-full h-auto"
          role="img"
          aria-label={t('loanDetail.scenarioChart.title')}
        >
          {/* Savings grid + ticks */}
          {yTicks.map((v) => (
            <g key={v}>
              <line
                x1={MARGIN.left}
                x2={W - MARGIN.right}
                y1={y(v)}
                y2={y(v)}
                stroke={chartColors.grid}
                strokeDasharray="3 3"
              />
              <text
                x={MARGIN.left - 10}
                y={y(v) + 4}
                textAnchor="end"
                fontSize={12}
                fill={chartColors.axis}
              >
                {formatCurrencyAxis(v)}
              </text>
            </g>
          ))}
          <text
            x={MARGIN.left - 66}
            y={MARGIN.top - 44}
            fontSize={12}
            fontWeight={600}
            className="fill-gray-500 dark:fill-gray-400"
          >
            {t('loanDetail.comparison.interestSaved')}
          </text>

          {/* Time axis */}
          <line
            x1={MARGIN.left}
            x2={W - MARGIN.right}
            y1={y0}
            y2={y0}
            stroke={chartColors.grid}
          />
          {yearTicks.map((year) => (
            <g key={year}>
              <line x1={x(year)} x2={x(year)} y1={y0} y2={y0 + 5} stroke={chartColors.grid} />
              <text
                x={x(year)}
                y={y0 + 20}
                textAnchor="middle"
                fontSize={12}
                fill={chartColors.axis}
              >
                {year}
              </text>
            </g>
          ))}

          {/* Baseline: flat dotted marker ending at the original payoff date */}
          <line
            x1={x(todayYear)}
            x2={x(baseline.payoffDate ? toYear(baseline.payoffDate) : xEnd)}
            y1={y0}
            y2={y0}
            stroke={chartColors.axis}
            strokeWidth={3}
            strokeDasharray="1 6"
            strokeLinecap="round"
          />
          <text
            x={x(baseline.payoffDate ? toYear(baseline.payoffDate) : xEnd)}
            y={y0 + 64}
            textAnchor="end"
            fontSize={12}
            fontWeight={600}
            className="fill-gray-500 dark:fill-gray-400"
          >
            {t('loanDetail.scenarioChart.baselineMarker', {
              date: payoffLabel(baseline.payoffDate),
            })}
          </text>

          {/* Scenario arcs: quadratic Bezier from (today, 0) to (payoff, 0);
              control height = 2x apex so the peak hits the savings value */}
          {drawOrder.map((s, drawIndex) => {
            const endYear = s.payoffDate ? toYear(s.payoffDate) : xEnd;
            const x0 = x(todayYear);
            const x1 = x(endYear);
            const midX = (x0 + x1) / 2;
            const saved = Math.max(0, s.interestSaved);
            const apexY = y(saved);
            const ctrlY = y0 - 2 * (y0 - apexY);
            const d = `M ${x0} ${y0} Q ${midX} ${ctrlY} ${x1} ${y0}`;
            const dimmed = hoveredId !== null && hoveredId !== s.id;
            const footLabelY = y0 + (drawIndex % 2 === 0 ? 36 : 50);

            return (
              <g
                key={s.id}
                onMouseEnter={() => setHoveredId(s.id)}
                onMouseLeave={() => setHoveredId(null)}
                className="transition-opacity duration-150"
                opacity={dimmed ? 0.3 : 1}
              >
                <path
                  d={d}
                  fill="none"
                  stroke={s.color}
                  strokeWidth={hoveredId === s.id ? 4 : 2.5}
                  strokeDasharray={s.payoffDate ? undefined : '6 4'}
                  data-testid="scenario-arc"
                />
                <path d={d} fill="none" stroke="transparent" strokeWidth={18} />
                <circle cx={midX} cy={apexY} r={4} fill={s.color} />
                <text
                  x={midX}
                  y={apexY - 34}
                  textAnchor="middle"
                  fontSize={13}
                  fontWeight={600}
                  className="fill-gray-900 dark:fill-gray-100"
                >
                  {s.name}
                </text>
                <text
                  x={midX}
                  y={apexY - 19}
                  textAnchor="middle"
                  fontSize={12}
                  className="fill-gray-500 dark:fill-gray-400"
                >
                  {overpaymentLabel(s)}
                </text>
                <text
                  x={midX}
                  y={apexY + 20}
                  textAnchor="middle"
                  fontSize={12}
                  fontWeight={600}
                  fill={s.color}
                >
                  {formatCurrency(saved, currencyCode)}
                </text>
                <line x1={x1} x2={x1} y1={y0} y2={y0 + 5} stroke={s.color} strokeWidth={2} />
                <text
                  x={x1}
                  y={footLabelY}
                  textAnchor="middle"
                  fontSize={12}
                  fontWeight={600}
                  fill={s.color}
                >
                  {payoffLabel(s.payoffDate)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      {/* Text restatement of all three figures per scenario (also the
          screen-reader/table fallback for the drawing) */}
      <ul className="flex flex-wrap gap-x-6 gap-y-1 mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
        {series.map((s) => (
          <li key={s.id} className="text-xs text-gray-500 dark:text-gray-400">
            <span
              className="inline-block w-3 h-1 rounded-sm align-middle mr-2"
              style={{ backgroundColor: s.color }}
            />
            <span className="font-semibold text-gray-700 dark:text-gray-300">{s.name}</span>
            {' · '}
            {overpaymentLabel(s)}
            {' · '}
            {payoffLabel(s.payoffDate)}
            {' · '}
            {formatCurrency(Math.max(0, s.interestSaved), currencyCode)}
          </li>
        ))}
      </ul>
    </div>
  );
}
