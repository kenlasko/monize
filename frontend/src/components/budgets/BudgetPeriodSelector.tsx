'use client';

import { format, parseISO } from 'date-fns';
import type { BudgetPeriod } from '@/types/budget';

interface BudgetPeriodSelectorProps {
  periods: BudgetPeriod[];
  selectedPeriodId: string | null;
  onPeriodChange: (periodId: string | null) => void;
}

function formatPeriodLabel(period: BudgetPeriod): string {
  const start = parseISO(period.periodStart);
  const label = format(start, 'MMM yyyy');
  if (period.status === 'OPEN') return `${label} (Current)`;
  if (period.status === 'PROJECTED') return `${label} (Projected)`;
  return label;
}

export function BudgetPeriodSelector({
  periods,
  selectedPeriodId,
  onPeriodChange,
}: BudgetPeriodSelectorProps) {
  if (periods.length <= 1) return null;

  return (
    <div className="flex items-center gap-2">
      <label
        htmlFor="period-selector"
        className="text-sm text-gray-600 dark:text-gray-400"
      >
        Period:
      </label>
      <select
        id="period-selector"
        value={selectedPeriodId ?? ''}
        onChange={(e) =>
          onPeriodChange(e.target.value === '' ? null : e.target.value)
        }
        className="text-sm border border-gray-300 dark:border-gray-600 rounded-md px-3 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
      >
        <option value="">Current Period</option>
        {periods.map((period) => (
          <option key={period.id} value={period.id}>
            {formatPeriodLabel(period)}
          </option>
        ))}
      </select>
    </div>
  );
}
