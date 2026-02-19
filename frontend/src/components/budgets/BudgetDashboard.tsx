'use client';

import { BudgetSummaryCards } from './BudgetSummaryCards';
import { BudgetHealthGauge } from './BudgetHealthGauge';
import { BudgetVelocityWidget } from './BudgetVelocityWidget';
import { BudgetCategoryList } from './BudgetCategoryList';
import { BudgetFlexGroupCard } from './BudgetFlexGroupCard';
import { BudgetUpcomingBills } from './BudgetUpcomingBills';
import { BudgetHeatmap } from './BudgetHeatmap';
import { BudgetTrendChart } from './BudgetTrendChart';
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

  return (
    <div className="space-y-6">
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

      {/* Flex Groups + Upcoming Bills */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <BudgetFlexGroupCard
          categories={summary.categoryBreakdown}
          budgetCategories={summary.budget.categories}
          formatCurrency={formatCurrency}
        />
        <BudgetUpcomingBills
          scheduledTransactions={scheduledTransactions}
          currentSpent={summary.totalSpent}
          totalBudgeted={summary.totalBudgeted}
          periodEnd={periodEnd}
          formatCurrency={formatCurrency}
        />
      </div>

      {/* Heatmap */}
      <BudgetHeatmap
        dailySpending={dailySpending}
        periodStart={periodStart}
        periodEnd={periodEnd}
        formatCurrency={formatCurrency}
      />

      {/* Trend Chart */}
      <BudgetTrendChart data={trendData} formatCurrency={formatCurrency} />
    </div>
  );
}
