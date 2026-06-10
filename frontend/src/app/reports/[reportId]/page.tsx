'use client';

import { Suspense, lazy, useState, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';

const reportComponents: Record<string, React.LazyExoticComponent<React.ComponentType>> = {
  'spending-by-category': lazy(() => import('@/components/reports/SpendingByCategoryReport').then(m => ({ default: m.SpendingByCategoryReport }))),
  'spending-by-payee': lazy(() => import('@/components/reports/SpendingByPayeeReport').then(m => ({ default: m.SpendingByPayeeReport }))),
  'monthly-spending-trend': lazy(() => import('@/components/reports/MonthlySpendingTrendReport').then(m => ({ default: m.MonthlySpendingTrendReport }))),
  'monthly-category-breakdown': lazy(() => import('@/components/reports/MonthlyCategoryBreakdownReport').then(m => ({ default: m.MonthlyCategoryBreakdownReport }))),
  'income-vs-expenses': lazy(() => import('@/components/reports/IncomeVsExpensesReport').then(m => ({ default: m.IncomeVsExpensesReport }))),
  'income-by-source': lazy(() => import('@/components/reports/IncomeBySourceReport').then(m => ({ default: m.IncomeBySourceReport }))),
  'net-worth': lazy(() => import('@/components/reports/NetWorthReport').then(m => ({ default: m.NetWorthReport }))),
  'account-balances': lazy(() => import('@/components/reports/AccountBalancesReport').then(m => ({ default: m.AccountBalancesReport }))),
  'cash-flow': lazy(() => import('@/components/reports/CashFlowReport').then(m => ({ default: m.CashFlowReport }))),
  'tax-summary': lazy(() => import('@/components/reports/TaxSummaryReport').then(m => ({ default: m.TaxSummaryReport }))),
  'year-over-year': lazy(() => import('@/components/reports/YearOverYearReport').then(m => ({ default: m.YearOverYearReport }))),
  // Debt & Loans
  'debt-payoff-timeline': lazy(() => import('@/components/reports/DebtPayoffTimelineReport').then(m => ({ default: m.DebtPayoffTimelineReport }))),
  'loan-amortization': lazy(() => import('@/components/reports/LoanAmortizationReport').then(m => ({ default: m.LoanAmortizationReport }))),
  'credit-utilization': lazy(() => import('@/components/reports/CreditUtilizationReport').then(m => ({ default: m.CreditUtilizationReport }))),
  // Investment
  'investment-performance': lazy(() => import('@/components/reports/InvestmentPerformanceReport').then(m => ({ default: m.InvestmentPerformanceReport }))),
  'dividend-income': lazy(() => import('@/components/reports/DividendIncomeReport').then(m => ({ default: m.DividendIncomeReport }))),
  'sector-weightings': lazy(() => import('@/components/reports/SectorWeightingsReport').then(m => ({ default: m.SectorWeightingsReport }))),
  'realized-gains': lazy(() => import('@/components/reports/RealizedGainsReport').then(m => ({ default: m.RealizedGainsReport }))),
  'portfolio-value': lazy(() => import('@/components/reports/PortfolioValueReport').then(m => ({ default: m.PortfolioValueReport }))),
  'investment-transactions': lazy(() => import('@/components/reports/InvestmentTransactionHistoryReport').then(m => ({ default: m.InvestmentTransactionHistoryReport }))),
  'security-type-allocation': lazy(() => import('@/components/reports/SecurityTypeAllocationReport').then(m => ({ default: m.SecurityTypeAllocationReport }))),
  'geographic-allocation': lazy(() => import('@/components/reports/GeographicAllocationReport').then(m => ({ default: m.GeographicAllocationReport }))),
  'dividend-yield-growth': lazy(() => import('@/components/reports/DividendYieldGrowthReport').then(m => ({ default: m.DividendYieldGrowthReport }))),
  'security-performance': lazy(() => import('@/components/reports/SecurityPerformanceReport').then(m => ({ default: m.SecurityPerformanceReport }))),
  'currency-exposure': lazy(() => import('@/components/reports/CurrencyExposureReport').then(m => ({ default: m.CurrencyExposureReport }))),
  'monte-carlo-simulation': lazy(() => import('@/components/reports/MonteCarloReport').then(m => ({ default: m.MonteCarloReport }))),
  // Behavioral Insights
  'recurring-expenses': lazy(() => import('@/components/reports/RecurringExpensesReport').then(m => ({ default: m.RecurringExpensesReport }))),
  'spending-anomalies': lazy(() => import('@/components/reports/SpendingAnomaliesReport').then(m => ({ default: m.SpendingAnomaliesReport }))),
  'weekend-weekday-spending': lazy(() => import('@/components/reports/WeekendVsWeekdayReport').then(m => ({ default: m.WeekendVsWeekdayReport }))),
  'monthly-comparison': lazy(() => import('@/components/reports/MonthlyComparisonReport').then(m => ({ default: m.MonthlyComparisonReport }))),
  // Maintenance & Cleanup
  'uncategorized-transactions': lazy(() => import('@/components/reports/UncategorizedTransactionsReport').then(m => ({ default: m.UncategorizedTransactionsReport }))),
  'duplicate-transactions': lazy(() => import('@/components/reports/DuplicateTransactionReport').then(m => ({ default: m.DuplicateTransactionReport }))),
  // Scheduled & Bills
  'upcoming-bills': lazy(() => import('@/components/reports/UpcomingBillsReport').then(m => ({ default: m.UpcomingBillsReport }))),
  'bill-payment-history': lazy(() => import('@/components/reports/BillPaymentHistoryReport').then(m => ({ default: m.BillPaymentHistoryReport }))),
  // Budget
  'budget-vs-actual': lazy(() => import('@/components/reports/BudgetVsActualReport').then(m => ({ default: m.BudgetVsActualReport }))),
  'budget-health-score': lazy(() => import('@/components/reports/BudgetHealthScoreReport').then(m => ({ default: m.BudgetHealthScoreReport }))),
  'budget-seasonal-patterns': lazy(() => import('@/components/reports/BudgetSeasonalPatternsReport').then(m => ({ default: m.BudgetSeasonalPatternsReport }))),
  'budget-trend': lazy(() => import('@/components/reports/BudgetTrendReport').then(m => ({ default: m.BudgetTrendReport }))),
  'category-performance': lazy(() => import('@/components/reports/CategoryPerformanceReport').then(m => ({ default: m.CategoryPerformanceReport }))),
  'savings-rate': lazy(() => import('@/components/reports/SavingsRateReport').then(m => ({ default: m.SavingsRateReport }))),
  'health-score-history': lazy(() => import('@/components/reports/HealthScoreHistoryReport').then(m => ({ default: m.HealthScoreHistoryReport }))),
  'flex-group-analysis': lazy(() => import('@/components/reports/FlexGroupAnalysisReport').then(m => ({ default: m.FlexGroupAnalysisReport }))),
  'seasonal-spending-map': lazy(() => import('@/components/reports/SeasonalSpendingMapReport').then(m => ({ default: m.SeasonalSpendingMapReport }))),
};


function ReportSkeleton() {
  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="animate-pulse flex gap-2">
          <div className="h-8 w-12 bg-gray-200 dark:bg-gray-700 rounded" />
          <div className="h-8 w-12 bg-gray-200 dark:bg-gray-700 rounded" />
          <div className="h-8 w-12 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
          <div className="h-64 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    </div>
  );
}

export default function ReportPage() {
  return (
    <ProtectedRoute>
      <ReportContent />
    </ProtectedRoute>
  );
}

function ReportContent() {
  const t = useTranslations('reports');
  const params = useParams();
  const reportId = params.reportId as string;

  // Force report remount after undo/redo so it re-fetches data
  const [refreshKey, setRefreshKey] = useState(0);
  const handleUndoRedo = useCallback(() => setRefreshKey((k) => k + 1), []);
  useOnUndoRedo(handleUndoRedo);

  const ReportComponent = reportComponents[reportId];

  if (!ReportComponent) {
    return (
      <PageLayout>
        <div className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-8 text-center">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">
              {t('reportPage.notFound')}
            </h1>
            <p className="text-gray-500 dark:text-gray-400">
              {t('reportPage.notFoundDesc')}
            </p>
          </div>
        </div>
      </PageLayout>
    );
  }

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title={t(`page.names.${reportId}` as Parameters<typeof t>[0])}
          subtitle={t(`page.descriptions.${reportId}` as Parameters<typeof t>[0])}
          actions={
            <Link href="/reports">
              <Button variant="outline">{t('reportPage.backToReports')}</Button>
            </Link>
          }
        />
        <Suspense fallback={<ReportSkeleton />}>
          <ReportComponent key={refreshKey} />
        </Suspense>
      </main>
    </PageLayout>
  );
}
