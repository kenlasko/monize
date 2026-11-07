'use client';

import { CashFlowType } from '@/lib/monte-carlo';
import { chartColors } from '@/lib/chart-colors';
import { useTranslations } from 'next-intl';
import { gainLossColor } from '@/lib/format';
import { CHART_TOOLTIP_CLASS } from '@/lib/chart-style';

export interface CashFlowEvent {
  role: 'start' | 'end';
  income: boolean;
  name: string;
  amount: number;
  flowType: CashFlowType;
  startYear: number;
  endYear?: number | null;
  inflationAdjust: boolean;
}

export function CashFlowLegendSwatch({
  role,
  income,
}: {
  role: 'start' | 'end';
  income: boolean;
}) {
  const fill = income ? chartColors.income : chartColors.expense;
  const points =
    role === 'start' ? '7,1 1,11 13,11' : '7,11 1,1 13,1';
  return (
    <svg width={14} height={12} viewBox="0 0 14 12" className="shrink-0">
      <polygon points={points} fill={fill} stroke="var(--color-white)" strokeWidth={1} />
    </svg>
  );
}

export function CashFlowMarker({
  cx,
  cy,
  role,
  income,
}: {
  cx: number;
  cy: number;
  role: 'start' | 'end';
  income: boolean;
}) {
  const fill = income ? chartColors.income : chartColors.expense;
  const stroke = 'var(--color-white)';
  // Triangle pointing up = start, pointing down = end. Income green, expense red.
  const size = 7;
  const points =
    role === 'start'
      ? `${cx},${cy - size} ${cx - size},${cy + size} ${cx + size},${cy + size}`
      : `${cx},${cy + size} ${cx - size},${cy - size} ${cx + size},${cy - size}`;
  return <polygon points={points} fill={fill} stroke={stroke} strokeWidth={1.5} />;
}

export function FanChartTooltip({
  active,
  payload,
  label,
  fmt,
  events,
}: {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: Record<string, number> }>;
  label?: string;
  fmt: (v: number) => string;
  events?: CashFlowEvent[];
}) {
  const t = useTranslations('reports');

  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  const rows: Array<[string, number]> = [
    [t('monteCarlo.tooltipRow90th'), row.p90],
    [t('monteCarlo.tooltipRow75th'), row.p75],
    [t('monteCarlo.tooltipRowMedian'), row.p50],
    [t('monteCarlo.tooltipRow25th'), row.p25],
    [t('monteCarlo.tooltipRow10th'), row.p10],
  ];
  return (
    <div className={`${CHART_TOOLTIP_CLASS} text-sm max-w-xs`}>
      <p className="font-medium text-gray-900 dark:text-gray-100 mb-1">{label}</p>
      {rows.map(([name, value]) => (
        <p
          key={name}
          className="text-gray-700 dark:text-gray-300 flex justify-between gap-4"
        >
          <span>{name}</span>
          <span className="font-medium text-gray-900 dark:text-gray-100">
            {fmt(value)}
          </span>
        </p>
      ))}
      {events && events.length > 0 && (
        <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700 space-y-1.5">
          {events.map((e, i) => (
            <div key={i} className="flex items-start gap-2">
              <CashFlowLegendSwatch role={e.role} income={e.income} />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-gray-900 dark:text-gray-100">
                  {e.flowType === 'ONE_TIME'
                    ? e.name
                    : `${e.role === 'start' ? t('monteCarloResults.starts') : t('monteCarloResults.ends')}: ${e.name}`}
                </div>
                <div className={gainLossColor(e.income ? 1 : -1)}>
                  {e.income ? '+' : ''}
                  {fmt(e.amount)}
                  {e.flowType === 'RECURRING' ? ` ${t('monteCarlo.cashFlowPerYear')}` : ''}
                  {e.inflationAdjust ? t('monteCarlo.tooltipInflated') : ''}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {e.flowType === 'ONE_TIME'
                    ? t('monteCarlo.cashFlowTypeOneTime')
                    : e.endYear
                      ? t('monteCarlo.tooltipRecurring', { startYear: e.startYear, endYear: e.endYear })
                      : t('monteCarlo.tooltipRecurringOpen', { startYear: e.startYear })}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
