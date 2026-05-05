'use client';

import { Button } from '@/components/ui/Button';
import {
  MonteCarloScenario,
  SimulationResult,
} from '@/lib/monte-carlo';
import {
  ROW_GROUPS,
  ScenarioContext,
  formatCellValue,
} from './compareMetricRows';

export type ColumnStatus = 'loading' | 'ok' | 'error' | 'missing';

export type CompareColumn = {
  id: string;
  status: ColumnStatus;
  scenario: MonteCarloScenario | null;
  result: SimulationResult | null;
  error?: string;
  fromCache?: boolean;
};

export interface CompareMetricTableProps {
  columns: CompareColumn[];
  formatCurrency: (value: number) => string;
  onRetry: (id: string) => void;
  onRemove: (id: string) => void;
  onRerun: (id: string) => void;
}

export function CompareMetricTable({
  columns,
  formatCurrency,
  onRetry,
  onRemove,
  onRerun,
}: CompareMetricTableProps) {
  return (
    <div className="overflow-x-auto bg-white dark:bg-gray-800 rounded-lg shadow">
      <table className="min-w-full text-sm border-separate border-spacing-0">
        <thead>
          <tr>
            <th
              className="sticky left-0 z-30 bg-gray-50 dark:bg-gray-900/40 px-3 py-3 text-left font-medium text-gray-500 dark:text-gray-400 min-w-[220px]"
              scope="col"
            >
              Metric
            </th>
            {columns.map((col) => (
              <th
                key={col.id}
                className="relative z-0 bg-gray-50 dark:bg-gray-900/40 px-3 py-3 text-left font-medium text-gray-700 dark:text-gray-200 min-w-[200px]"
                scope="col"
              >
                <ColumnHeader
                  column={col}
                  onRemove={() => onRemove(col.id)}
                  onRerun={() => onRerun(col.id)}
                />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
          {ROW_GROUPS.map((group) => (
            <GroupBlock
              key={group.key}
              group={group}
              columns={columns}
              formatCurrency={formatCurrency}
              onRetry={onRetry}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ColumnHeader({
  column,
  onRemove,
  onRerun,
}: {
  column: CompareColumn;
  onRemove: () => void;
  onRerun: () => void;
}) {
  const title = column.scenario?.name ?? 'Scenario';
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-gray-900 dark:text-gray-100 truncate">
          {title}
        </span>
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${title} from comparison`}
          className="text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
          title="Remove from comparison"
        >
          <svg
            className="w-4 h-4"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden="true"
          >
            <path
              fillRule="evenodd"
              d="M4.28 4.22a.75.75 0 011.06 0L10 8.94l4.66-4.72a.75.75 0 111.07 1.05L11.06 10l4.67 4.73a.75.75 0 11-1.07 1.05L10 11.06l-4.66 4.72a.75.75 0 11-1.07-1.05L8.94 10 4.28 5.27a.75.75 0 010-1.05z"
              clipRule="evenodd"
            />
          </svg>
        </button>
      </div>
      {column.status === 'ok' && (
        <div className="flex items-center gap-2">
          {column.fromCache && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300">
              cached
            </span>
          )}
          <button
            type="button"
            onClick={onRerun}
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            Re-run
          </button>
        </div>
      )}
      {column.status === 'loading' && (
        <span className="text-xs text-gray-500 dark:text-gray-400">
          Running…
        </span>
      )}
    </div>
  );
}

function GroupBlock({
  group,
  columns,
  formatCurrency,
  onRetry,
}: {
  group: (typeof ROW_GROUPS)[number];
  columns: CompareColumn[];
  formatCurrency: (n: number) => string;
  onRetry: (id: string) => void;
}) {
  return (
    <>
      <tr className="bg-gray-100 dark:bg-gray-900/60">
        <td
          colSpan={columns.length + 1}
          className="bg-gray-100 dark:bg-gray-900/60 px-0 py-0 text-xs font-semibold uppercase tracking-wide text-gray-600 dark:text-gray-300"
        >
          <span className="sticky left-0 inline-block px-3 py-2">
            {group.label}
          </span>
        </td>
      </tr>
      {group.rows.map((row) => (
        <tr
          key={row.key}
          className={
            row.subgroupStart
              ? 'border-t-2 border-gray-300 dark:border-gray-600'
              : undefined
          }
        >
          <th
            scope="row"
            className="sticky left-0 z-10 bg-white dark:bg-gray-800 px-3 py-1.5 text-left font-normal text-gray-700 dark:text-gray-300"
          >
            {row.label}
          </th>
          {columns.map((col) => {
            if (col.status === 'loading' && !col.scenario) {
              return (
                <td
                  key={col.id}
                  className="px-3 py-1.5 text-gray-400 dark:text-gray-500"
                >
                  <span className="inline-block w-16 h-3 bg-gray-200 dark:bg-gray-700 rounded animate-pulse" />
                </td>
              );
            }
            if (col.status === 'missing') {
              return (
                <td
                  key={col.id}
                  className="px-3 py-1.5 text-xs text-amber-700 dark:text-amber-400 italic"
                >
                  Scenario no longer exists
                </td>
              );
            }
            if (col.status === 'error' && !col.result) {
              return (
                <td key={col.id} className="px-3 py-1.5">
                  <div className="flex flex-col gap-1">
                    <span className="text-xs text-red-600 dark:text-red-400">
                      {col.error ?? 'Run failed'}
                    </span>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => onRetry(col.id)}
                    >
                      Retry
                    </Button>
                  </div>
                </td>
              );
            }
            const ctx: ScenarioContext = {
              scenario: col.scenario!,
              result: col.result,
            };
            const value = row.accessor(ctx);
            return (
              <td
                key={col.id}
                className="px-3 py-1.5 text-gray-900 dark:text-gray-100 tabular-nums"
              >
                {formatCellValue(value, row.format, formatCurrency)}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}
