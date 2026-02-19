'use client';

interface BudgetZeroBasedBarProps {
  totalIncome: number;
  totalBudgeted: number;
  formatCurrency: (amount: number) => string;
}

export function BudgetZeroBasedBar({
  totalIncome,
  totalBudgeted,
  formatCurrency,
}: BudgetZeroBasedBarProps) {
  const unassigned = totalIncome - totalBudgeted;
  const assignedPercent =
    totalIncome > 0
      ? Math.min((totalBudgeted / totalIncome) * 100, 100)
      : 0;

  const tolerance = totalIncome * 0.02;
  const isFullyAssigned = Math.abs(unassigned) <= tolerance;
  const isOverAssigned = unassigned < -tolerance;

  let statusColor: string;
  let statusLabel: string;
  if (isFullyAssigned) {
    statusColor = 'text-green-600 dark:text-green-400';
    statusLabel = 'Fully assigned';
  } else if (isOverAssigned) {
    statusColor = 'text-red-600 dark:text-red-400';
    statusLabel = 'Over-assigned';
  } else {
    statusColor = 'text-yellow-600 dark:text-yellow-400';
    statusLabel = 'Under-assigned';
  }

  let barColor: string;
  if (isFullyAssigned) {
    barColor = 'bg-green-500 dark:bg-green-400';
  } else if (isOverAssigned) {
    barColor = 'bg-red-500 dark:bg-red-400';
  } else {
    barColor = 'bg-yellow-500 dark:bg-yellow-400';
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          Zero-Based Assignment
        </h3>
        <span className={`text-sm font-medium ${statusColor}`}>
          {statusLabel}
        </span>
      </div>
      <div className="relative w-full h-4 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-300 ${barColor}`}
          style={{ width: `${assignedPercent}%` }}
        />
      </div>
      <div className="flex items-center justify-between mt-2 text-sm">
        <span className="text-gray-600 dark:text-gray-300">
          Assigned: {formatCurrency(totalBudgeted)} / {formatCurrency(totalIncome)}
        </span>
        <span className={statusColor}>
          {unassigned >= 0
            ? `${formatCurrency(unassigned)} unassigned`
            : `${formatCurrency(Math.abs(unassigned))} over`}
        </span>
      </div>
    </div>
  );
}
