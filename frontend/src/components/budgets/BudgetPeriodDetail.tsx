'use client';

import { format, parseISO } from 'date-fns';
import { BudgetProgressBar } from './BudgetProgressBar';
import type { BudgetPeriod, BudgetPeriodCategory } from '@/types/budget';

interface BudgetPeriodDetailProps {
  period: BudgetPeriod;
  formatCurrency: (amount: number) => string;
}

function getCategoryName(pc: BudgetPeriodCategory): string {
  if (pc.category?.name) return pc.category.name;
  if (pc.budgetCategory?.category?.name) return pc.budgetCategory.category.name;
  return 'Uncategorized';
}

function isIncomeCategory(pc: BudgetPeriodCategory): boolean {
  if (pc.budgetCategory?.isIncome) return true;
  if (pc.category?.isIncome) return true;
  return false;
}

export function BudgetPeriodDetail({
  period,
  formatCurrency,
}: BudgetPeriodDetailProps) {
  const categories = period.periodCategories ?? [];
  const expenseCategories = categories.filter((pc) => !isIncomeCategory(pc));
  const incomeCategories = categories.filter((pc) => isIncomeCategory(pc));

  const totalBudgeted = expenseCategories.reduce(
    (sum, pc) => sum + Number(pc.effectiveBudget),
    0,
  );
  const totalSpent = expenseCategories.reduce(
    (sum, pc) => sum + Number(pc.actualAmount),
    0,
  );
  const totalIncome = incomeCategories.reduce(
    (sum, pc) => sum + Number(pc.actualAmount),
    0,
  );
  const remaining = totalBudgeted - totalSpent;
  const percentUsed = totalBudgeted > 0
    ? Math.round((totalSpent / totalBudgeted) * 10000) / 100
    : 0;
  const totalRolloverIn = expenseCategories.reduce(
    (sum, pc) => sum + Number(pc.rolloverIn),
    0,
  );
  const totalRolloverOut = expenseCategories.reduce(
    (sum, pc) => sum + Number(pc.rolloverOut),
    0,
  );

  const periodLabel = `${format(parseISO(period.periodStart), 'MMMM yyyy')}`;

  return (
    <div className="space-y-6">
      {/* Period Header */}
      <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {periodLabel}
          </h2>
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300">
            {period.status}
          </span>
        </div>
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {format(parseISO(period.periodStart), 'MMM d')} &ndash;{' '}
          {format(parseISO(period.periodEnd), 'MMM d, yyyy')}
        </p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <SummaryCard
          label="Total Budgeted"
          value={formatCurrency(totalBudgeted)}
          sublabel={`${expenseCategories.length} categories`}
        />
        <SummaryCard
          label="Total Spent"
          value={formatCurrency(totalSpent)}
          sublabel={`${percentUsed}%`}
          valueColor={percentUsed > 100 ? 'text-red-600 dark:text-red-400' : undefined}
        />
        <SummaryCard
          label={remaining >= 0 ? 'Under Budget' : 'Over Budget'}
          value={formatCurrency(Math.abs(remaining))}
          sublabel={remaining >= 0 ? 'saved' : 'overspent'}
          valueColor={
            remaining >= 0
              ? 'text-green-600 dark:text-green-400'
              : 'text-red-600 dark:text-red-400'
          }
        />
        <SummaryCard
          label="Income"
          value={formatCurrency(totalIncome)}
          sublabel={totalIncome > 0 ? `Savings: ${formatCurrency(totalIncome - totalSpent)}` : undefined}
        />
      </div>

      {/* Rollover Summary */}
      {(totalRolloverIn > 0 || totalRolloverOut > 0) && (
        <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4">
          <h3 className="text-sm font-medium text-blue-800 dark:text-blue-200 mb-2">
            Rollover Summary
          </h3>
          <div className="flex gap-6 text-sm">
            <div>
              <span className="text-blue-600 dark:text-blue-300">Carried in: </span>
              <span className="font-medium text-blue-900 dark:text-blue-100">
                {formatCurrency(totalRolloverIn)}
              </span>
            </div>
            <div>
              <span className="text-blue-600 dark:text-blue-300">Carried out: </span>
              <span className="font-medium text-blue-900 dark:text-blue-100">
                {formatCurrency(totalRolloverOut)}
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Overall Progress */}
      <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6">
        <div className="flex justify-between items-center mb-2">
          <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
            Overall Budget Usage
          </span>
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {formatCurrency(totalSpent)} / {formatCurrency(totalBudgeted)}
          </span>
        </div>
        <BudgetProgressBar percentUsed={percentUsed} />
      </div>

      {/* Expense Categories */}
      {expenseCategories.length > 0 && (
        <div className="bg-white dark:bg-gray-800 shadow rounded-lg overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-base font-medium text-gray-900 dark:text-gray-100">
              Expense Categories
            </h3>
          </div>
          <div className="divide-y divide-gray-200 dark:divide-gray-700">
            {[...expenseCategories]
              .sort((a, b) => {
                const pctA = Number(a.effectiveBudget) > 0
                  ? Number(a.actualAmount) / Number(a.effectiveBudget)
                  : 0;
                const pctB = Number(b.effectiveBudget) > 0
                  ? Number(b.actualAmount) / Number(b.effectiveBudget)
                  : 0;
                return pctB - pctA;
              })
              .map((pc) => (
                <PeriodCategoryRow
                  key={pc.id}
                  periodCategory={pc}
                  formatCurrency={formatCurrency}
                />
              ))}
          </div>
        </div>
      )}

      {/* Income Categories */}
      {incomeCategories.length > 0 && (
        <div className="bg-white dark:bg-gray-800 shadow rounded-lg overflow-hidden">
          <div className="px-6 py-4 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-base font-medium text-gray-900 dark:text-gray-100">
              Income Categories
            </h3>
          </div>
          <div className="divide-y divide-gray-200 dark:divide-gray-700">
            {incomeCategories.map((pc) => (
              <PeriodCategoryRow
                key={pc.id}
                periodCategory={pc}
                formatCurrency={formatCurrency}
                isIncome
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  sublabel,
  valueColor,
}: {
  label: string;
  value: string;
  sublabel?: string;
  valueColor?: string;
}) {
  return (
    <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-4">
      <p className="text-sm text-gray-500 dark:text-gray-400">{label}</p>
      <p className={`text-xl font-semibold mt-1 ${valueColor ?? 'text-gray-900 dark:text-gray-100'}`}>
        {value}
      </p>
      {sublabel && (
        <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">
          {sublabel}
        </p>
      )}
    </div>
  );
}

function PeriodCategoryRow({
  periodCategory,
  formatCurrency,
  isIncome = false,
}: {
  periodCategory: BudgetPeriodCategory;
  formatCurrency: (amount: number) => string;
  isIncome?: boolean;
}) {
  const name = getCategoryName(periodCategory);
  const budgeted = Number(periodCategory.effectiveBudget);
  const spent = Number(periodCategory.actualAmount);
  const rolloverIn = Number(periodCategory.rolloverIn);
  const rolloverOut = Number(periodCategory.rolloverOut);
  const remaining = budgeted - spent;
  const percentUsed = budgeted > 0
    ? Math.round((spent / budgeted) * 10000) / 100
    : 0;

  return (
    <div className="px-6 py-4">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
            {name}
          </span>
          {rolloverIn > 0 && (
            <span className="text-xs px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-900 text-blue-700 dark:text-blue-300">
              +{formatCurrency(rolloverIn)} rollover
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-gray-500 dark:text-gray-400">
            {formatCurrency(spent)} / {formatCurrency(budgeted)}
          </span>
          {!isIncome && (
            <span
              className={`font-medium ${
                percentUsed > 100
                  ? 'text-red-600 dark:text-red-400'
                  : percentUsed > 80
                    ? 'text-yellow-600 dark:text-yellow-400'
                    : 'text-green-600 dark:text-green-400'
              }`}
            >
              {percentUsed}%
            </span>
          )}
        </div>
      </div>
      {!isIncome && <BudgetProgressBar percentUsed={percentUsed} />}
      <div className="flex items-center justify-between mt-1">
        <div className="text-xs text-gray-400 dark:text-gray-500">
          {!isIncome && (
            remaining >= 0
              ? `${formatCurrency(remaining)} under budget`
              : `${formatCurrency(Math.abs(remaining))} over budget`
          )}
        </div>
        {rolloverOut > 0 && (
          <span className="text-xs text-gray-400 dark:text-gray-500">
            {formatCurrency(rolloverOut)} carried forward
          </span>
        )}
      </div>
    </div>
  );
}
