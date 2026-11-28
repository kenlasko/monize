'use client';

import { useTranslations } from 'next-intl';
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
import { BudgetBucketSummary, type BudgetBucketStatusState } from './BudgetBucketSummary';
import { BudgetScenarioPlanner } from './BudgetScenarioPlanner';
import { STRATEGY_LABELS, STRATEGY_DESCRIPTIONS } from './utils/budget-labels';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { ProvisionalDataNotice } from '@/components/reports/ProvisionalDataNotice';
import type { BudgetSummary, BudgetTrendPoint, BudgetVelocity } from '@/types/budget';
import type { ScheduledTransaction } from '@/types/scheduled-transaction';

interface DailySpending {
  date: string;
  amount: number;
}

interface BudgetDashboardProps {
  summary: BudgetSummary;
  velocity: BudgetVelocity;
  scheduledTransactions: ScheduledTransaction[];
  dailySpending: DailySpending[];
  trendData: BudgetTrendPoint[];
  healthScore: number;
  /** The bucket-status request's state; read only for a Bucket budget. */
  bucketStatus?: BudgetBucketStatusState;
  /**
   * The budget's own currency: what `formatCurrency` labels a bare amount with,
   * and what the upcoming-bills panel converts each occurrence into.
   */
  displayCurrency: string;
  formatCurrency: (amount: number, currencyCode?: string) => string;
  onCategoryClick?: (budgetCategoryId: string) => void;
}

export function BudgetDashboard({
  summary,
  velocity,
  scheduledTransactions,
  dailySpending,
  trendData,
  healthScore,
  bucketStatus,
  displayCurrency,
  formatCurrency,
  onCategoryClick,
}: BudgetDashboardProps) {
  const tp = useTranslations('budgets');
  const { periodStart, periodEnd } = summary;

  // Compute pace percent: what % of the period has elapsed
  const pacePercent =
    velocity.totalDays > 0
      ? (velocity.daysElapsed / velocity.totalDays) * 100
      : 0;

  const strategy = summary.budget.strategy;
  const missingPairs = (summary.missingRatePairs ?? []).join(', ');

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
      {summary.totalSpent === null || summary.remaining === null || summary.percentUsed === null ? (
        // A row with no exchange rate makes the totals unknown, not small: the
        // cards would print the converted part as the whole.
        <div
          className="rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-4 text-sm text-amber-800 dark:text-amber-200"
          data-testid="budget-partial-spent"
          role="note"
        >
          <div className="flex items-center gap-2 font-medium">
            <UnknownAmount reasonText={tp('partialSpent.reason', { pairs: missingPairs })} />
            {tp('partialSpent.known', { amount: formatCurrency(summary.knownTotalSpent ?? 0) })}
          </div>
          <p className="mt-1">{tp('partialSpent.reason', { pairs: missingPairs })}</p>
        </div>
      ) : (
        <BudgetSummaryCards
          totalBudgeted={summary.totalBudgeted}
          totalSpent={summary.totalSpent}
          remaining={summary.remaining}
          totalIncome={summary.totalIncome}
          percentUsed={summary.percentUsed}
          daysRemaining={velocity.daysRemaining}
          displayCurrency={displayCurrency}
          formatCurrency={formatCurrency}
        />
      )}
      {/* A transfer line's actual can hold an imported estimate of a
          cross-currency leg; the figures include it and the note says so. */}
      <ProvisionalDataNotice count={summary.provisionalCount} />

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

      {strategy === 'BUCKET' && (
        <BudgetBucketSummary
          budgetId={summary.budget.id}
          status={bucketStatus ?? { state: 'loading' }}
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
          displayCurrency={displayCurrency}
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

      {/* What-If Scenario Planner */}
      <BudgetScenarioPlanner
        categories={summary.categoryBreakdown}
        totalIncome={summary.totalIncome}
        formatCurrency={formatCurrency}
      />
    </div>
  );
}
