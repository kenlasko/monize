'use client';

import type { BudgetVelocity } from '@/types/budget';

interface BudgetVelocityWidgetProps {
  velocity: BudgetVelocity;
  formatCurrency: (amount: number) => string;
}

function getPaceColor(paceStatus: BudgetVelocity['paceStatus']): string {
  switch (paceStatus) {
    case 'under':
      return 'text-green-600 dark:text-green-400';
    case 'on_track':
      return 'text-blue-600 dark:text-blue-400';
    case 'over':
      return 'text-red-600 dark:text-red-400';
  }
}

function getPaceBgColor(paceStatus: BudgetVelocity['paceStatus']): string {
  switch (paceStatus) {
    case 'under':
      return 'bg-green-50 dark:bg-green-900/20';
    case 'on_track':
      return 'bg-blue-50 dark:bg-blue-900/20';
    case 'over':
      return 'bg-red-50 dark:bg-red-900/20';
  }
}

function getPaceLabel(paceStatus: BudgetVelocity['paceStatus']): string {
  switch (paceStatus) {
    case 'under':
      return 'Under budget pace';
    case 'on_track':
      return 'On track';
    case 'over':
      return 'Over budget pace';
  }
}

export function BudgetVelocityWidget({
  velocity,
  formatCurrency,
}: BudgetVelocityWidgetProps) {
  const paceColor = getPaceColor(velocity.paceStatus);
  const paceBgColor = getPaceBgColor(velocity.paceStatus);
  const paceLabel = getPaceLabel(velocity.paceStatus);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 sm:p-6">
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Spending Velocity
        </h2>
        <span className={`px-2.5 py-1 text-xs font-semibold rounded-full ${paceColor} ${paceBgColor}`}>
          {paceLabel}
        </span>
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">
            Daily burn rate
          </div>
          <div className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {formatCurrency(velocity.dailyBurnRate)}/day
          </div>
        </div>
        <div>
          <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">
            Safe to spend
          </div>
          <div className="text-lg font-semibold text-green-600 dark:text-green-400">
            {formatCurrency(velocity.safeDailySpend)}/day
          </div>
        </div>
        <div>
          <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">
            Projected month-end
          </div>
          <div className={`text-lg font-semibold ${
            velocity.projectedVariance > 0
              ? 'text-red-600 dark:text-red-400'
              : 'text-gray-900 dark:text-gray-100'
          }`}>
            {formatCurrency(velocity.projectedTotal)}
          </div>
        </div>
        <div>
          <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">
            Budget total
          </div>
          <div className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {formatCurrency(velocity.budgetTotal)}
          </div>
        </div>
      </div>
      {velocity.totalUpcomingBills > 0 && (
        <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 grid grid-cols-2 gap-4">
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">
              Bills coming
            </div>
            <div className="text-lg font-semibold text-red-600 dark:text-red-400">
              {formatCurrency(velocity.totalUpcomingBills)}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400 mb-1">
              Truly available
            </div>
            <div className={`text-lg font-semibold ${
              velocity.trulyAvailable >= 0
                ? 'text-green-600 dark:text-green-400'
                : 'text-red-600 dark:text-red-400'
            }`}>
              {formatCurrency(Math.abs(velocity.trulyAvailable))}
              {velocity.trulyAvailable < 0 && ' over'}
            </div>
          </div>
        </div>
      )}
      <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between text-sm text-gray-500 dark:text-gray-400">
        <span>Day {velocity.daysElapsed} of {velocity.totalDays}</span>
        <span>{velocity.daysRemaining} days remaining</span>
      </div>
    </div>
  );
}
