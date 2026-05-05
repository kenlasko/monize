'use client';

import { CashFlowType } from '@/lib/monte-carlo';

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
  const fill = income ? '#16a34a' : '#dc2626';
  const points =
    role === 'start' ? '7,1 1,11 13,11' : '7,11 1,1 13,1';
  return (
    <svg width={14} height={12} viewBox="0 0 14 12" className="shrink-0">
      <polygon points={points} fill={fill} stroke="#ffffff" strokeWidth={1} />
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
  const fill = income ? '#16a34a' : '#dc2626';
  const stroke = '#ffffff';
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
  payload?: Array<{ payload?: Record<string, number> }>;
  label?: string;
  fmt: (v: number) => string;
  events?: CashFlowEvent[];
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  const rows: Array<[string, number]> = [
    ['90th percentile', row.p90],
    ['75th percentile', row.p75],
    ['Median (50th)', row.p50],
    ['25th percentile', row.p25],
    ['10th percentile', row.p10],
  ];
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3 text-sm max-w-xs">
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
                    : `${e.role === 'start' ? 'Starts' : 'Ends'}: ${e.name}`}
                </div>
                <div
                  className={
                    e.income
                      ? 'text-emerald-700 dark:text-emerald-400'
                      : 'text-red-700 dark:text-red-400'
                  }
                >
                  {e.income ? '+' : ''}
                  {fmt(e.amount)}
                  {e.flowType === 'RECURRING' ? ' / yr' : ''}
                  {e.inflationAdjust ? ' (inflated)' : ''}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {e.flowType === 'ONE_TIME'
                    ? 'One-time'
                    : `Recurring · year ${e.startYear}${
                        e.endYear ? `–${e.endYear}` : '+'
                      }`}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
