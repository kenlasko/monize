'use client';

import { CashFlowEvent, CashFlowLegendSwatch } from './MonteCarloChartParts';

export function SummaryStat({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div
      className={`bg-white dark:bg-gray-800 rounded-lg shadow p-4 ${className ?? ''}`}
    >
      <div className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400">
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold text-gray-900 dark:text-gray-100 break-words">
        {value}
      </div>
    </div>
  );
}

export function ResultsTable({
  rows,
  formatCurrency,
}: {
  rows: Array<{
    year: string;
    p10: number;
    p25: number;
    p50: number;
    p75: number;
    p90: number;
    events: CashFlowEvent[];
  }>;
  formatCurrency: (v: number) => string;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="min-w-full text-xs">
        <thead className="bg-gray-50 dark:bg-gray-900/40 text-gray-500 dark:text-gray-400">
          <tr>
            <th className="px-3 py-2 text-left font-medium">Year</th>
            <th className="px-3 py-2 text-right font-medium">10th</th>
            <th className="px-3 py-2 text-right font-medium">25th</th>
            <th className="px-3 py-2 text-right font-medium">Median</th>
            <th className="px-3 py-2 text-right font-medium">75th</th>
            <th className="px-3 py-2 text-right font-medium">90th</th>
            <th className="px-3 py-2 text-left font-medium">Events</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
          {rows.map((r) => (
            <tr key={r.year}>
              <td className="px-3 py-1.5 font-mono text-gray-900 dark:text-gray-100">
                {r.year}
              </td>
              <td className="px-3 py-1.5 text-right">{formatCurrency(r.p10)}</td>
              <td className="px-3 py-1.5 text-right">{formatCurrency(r.p25)}</td>
              <td className="px-3 py-1.5 text-right font-medium text-gray-900 dark:text-gray-100">
                {formatCurrency(r.p50)}
              </td>
              <td className="px-3 py-1.5 text-right">{formatCurrency(r.p75)}</td>
              <td className="px-3 py-1.5 text-right">{formatCurrency(r.p90)}</td>
              <td className="px-3 py-1.5">
                {r.events.length === 0 ? (
                  <span className="text-gray-400 dark:text-gray-500">—</span>
                ) : (
                  <div className="flex flex-col gap-0.5">
                    {r.events.map((e, i) => (
                      <span
                        key={i}
                        className={`inline-flex items-center gap-1 ${
                          e.income
                            ? 'text-emerald-700 dark:text-emerald-400'
                            : 'text-red-700 dark:text-red-400'
                        }`}
                      >
                        <CashFlowLegendSwatch role={e.role} income={e.income} />
                        {e.flowType === 'ONE_TIME'
                          ? e.name
                          : `${e.role === 'start' ? 'Starts' : 'Ends'}: ${e.name}`}
                      </span>
                    ))}
                  </div>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
