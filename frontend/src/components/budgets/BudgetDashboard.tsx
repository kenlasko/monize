'use client';

import { BudgetSummaryCards } from './BudgetSummaryCards';
import { BudgetHealthGauge } from './BudgetHealthGauge';
import { BudgetVelocityWidget } from './BudgetVelocityWidget';
import { BudgetCategoryList } from './BudgetCategoryList';
import { BudgetFlexGroupCard } from './BudgetFlexGroupCard';
import { BudgetUpcomingBills } from './BudgetUpcomingBills';
import { BudgetHeatmap } from './BudgetHeatmap';
import { BudgetTrendChart } from './BudgetTrendChart';
import { BudgetZeroBasedBar } from './BudgetZeroBasedBar';
import { Budget503020Summary } from './Budget503020Summary';
import { STRATEGY_LABELS, STRATEGY_DESCRIPTIONS } from './utils/budget-labels';
import type { BudgetSummary, BudgetVelocity } from '@/types/budget';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';

interface DailySpending {
  date: string;
  amount: number;
}

interface TrendDataPoint {
  month: string;
  budgeted: number;
  actual: number;
}

interface BudgetDashboardProps {
  summary: BudgetSummary;
  velocity: BudgetVelocity;
  scheduledTransactions: ScheduledTransaction[];
  dailySpending: DailySpending[];
  trendData: TrendDataPoint[];
  healthScore: number;
  formatCurrency: (amount: number) => string;
  onCategoryClick?: (budgetCategoryId: string) => void;
}

export function BudgetDashboard({
  summary,
  velocity,
  scheduledTransactions,
  dailySpending,
  trendData,
  healthScore,
  formatCurrency,
  onCategoryClick,
}: BudgetDashboardProps) {
  const periodEnd = summary.budget.periodEnd
    ?? new Date(
      new Date(summary.budget.periodStart + 'T00:00:00').getFullYear(),
      new Date(summary.budget.periodStart + 'T00:00:00').getMonth() + 1,
      0,
    )
      .toISOString()
      .split('T')[0];

  const periodStart = summary.budget.periodStart;

  // Compute pace percent: what % of the period has elapsed
  const pacePercent =
    velocity.totalDays > 0
      ? (velocity.daysElapsed / velocity.totalDays) * 100
      : 0;

  const strategy = summary.budget.strategy;

  return (
    <div className="space-y-6">
      {/* Strategy info bar */}
      <div className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-50 dark:bg-blue-900/20 text-sm">
        <span className="font-medium text-blue-700 dark:text-blue-300">
          {STRATEGY_LABELS[strategy] ?? strategy}
        </span>
        <span className="hidden sm:inline text-blue-600 dark:text-blue-400">
          &mdash; {STRATEGY_DESCRIPTIONS[strategy] ?? ''}
        </span>
      </div>

      {/* Summary Cards */}
      <BudgetSummaryCards
        totalBudgeted={summary.totalBudgeted}
        totalSpent={summary.totalSpent}
        remaining={summary.remaining}
        totalIncome={summary.totalIncome}
        percentUsed={summary.percentUsed}
        daysRemaining={velocity.daysRemaining}
        formatCurrency={formatCurrency}
      />

      {/* Strategy-specific widgets */}
      {strategy === 'ZERO_BASED' && (
        <BudgetZeroBasedBar
          totalIncome={summary.totalIncome}
          totalBudgeted={summary.totalBudgeted}
          formatCurrency={formatCurrency}
        />
      )}
      {strategy === 'FIFTY_THIRTY_TWENTY' && (
        <Budget503020Summary
          budgetCategories={summary.budget.categories}
          categoryBreakdown={summary.categoryBreakdown}
          totalIncome={summary.totalIncome}
          formatCurrency={formatCurrency}
        />
      )}

      {/* Health Gauge + Velocity Widget */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <BudgetHealthGauge score={healthScore} />
        <BudgetVelocityWidget
          velocity={velocity}
          formatCurrency={formatCurrency}
        />
      </div>

      {/* Category List */}
      <BudgetCategoryList
        categories={summary.categoryBreakdown}
        budgetCategories={summary.budget.categories}
        formatCurrency={formatCurrency}
        pacePercent={pacePercent}
        onCategoryClick={onCategoryClick}
      />

      {/* Flex Groups */}
      <BudgetFlexGroupCard
        categories={summary.categoryBreakdown}
        budgetCategories={summary.budget.categories}
        formatCurrency={formatCurrency}
      />

      {/* Upcoming Bills + Heatmap */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <BudgetUpcomingBills
          scheduledTransactions={scheduledTransactions}
          currentSpent={summary.totalSpent}
          totalBudgeted={summary.totalBudgeted}
          periodEnd={periodEnd}
          formatCurrency={formatCurrency}
        />
        <BudgetHeatmap
          dailySpending={dailySpending}
          periodStart={periodStart}
          periodEnd={periodEnd}
          formatCurrency={formatCurrency}
        />
      </div>

      {/* Trend Chart */}
      <BudgetTrendChart data={trendData} formatCurrency={formatCurrency} />
    </div>
  );
}
