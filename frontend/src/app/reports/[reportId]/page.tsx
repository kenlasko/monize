'use client';

import { Suspense, lazy } from 'react';
import { useParams } from 'next/navigation';
import { AppHeader } from '@/components/layout/AppHeader';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';

const reportComponents: Record<string, React.LazyExoticComponent<React.ComponentType>> = {
  'spending-by-category': lazy(() => import('@/components/reports/SpendingByCategoryReport').then(m => ({ default: m.SpendingByCategoryReport }))),
  'spending-by-payee': lazy(() => import('@/components/reports/SpendingByPayeeReport').then(m => ({ default: m.SpendingByPayeeReport }))),
  'monthly-spending-trend': lazy(() => import('@/components/reports/MonthlySpendingTrendReport').then(m => ({ default: m.MonthlySpendingTrendReport }))),
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
  // Investment
  'investment-performance': lazy(() => import('@/components/reports/InvestmentPerformanceReport').then(m => ({ default: m.InvestmentPerformanceReport }))),
  'dividend-income': lazy(() => import('@/components/reports/DividendIncomeReport').then(m => ({ default: m.DividendIncomeReport }))),
  // Behavioral Insights
  'recurring-expenses': lazy(() => import('@/components/reports/RecurringExpensesReport').then(m => ({ default: m.RecurringExpensesReport }))),
  'spending-anomalies': lazy(() => import('@/components/reports/SpendingAnomaliesReport').then(m => ({ default: m.SpendingAnomaliesReport }))),
  'weekend-weekday-spending': lazy(() => import('@/components/reports/WeekendVsWeekdayReport').then(m => ({ default: m.WeekendVsWeekdayReport }))),
  // Maintenance & Cleanup
  'uncategorized-transactions': lazy(() => import('@/components/reports/UncategorizedTransactionsReport').then(m => ({ default: m.UncategorizedTransactionsReport }))),
  'duplicate-transactions': lazy(() => import('@/components/reports/DuplicateTransactionReport').then(m => ({ default: m.DuplicateTransactionReport }))),
  // Scheduled & Bills
  'upcoming-bills': lazy(() => import('@/components/reports/UpcomingBillsReport').then(m => ({ default: m.UpcomingBillsReport }))),
  'bill-payment-history': lazy(() => import('@/components/reports/BillPaymentHistoryReport').then(m => ({ default: m.BillPaymentHistoryReport }))),
};

const reportNames: Record<string, string> = {
  'spending-by-category': 'Spending by Category',
  'spending-by-payee': 'Spending by Payee',
  'monthly-spending-trend': 'Monthly Spending Trend',
  'income-vs-expenses': 'Income vs Expenses',
  'income-by-source': 'Income by Source',
  'net-worth': 'Net Worth Over Time',
  'account-balances': 'Account Balances',
  'cash-flow': 'Cash Flow Statement',
  'tax-summary': 'Tax Summary',
  'year-over-year': 'Year Over Year Comparison',
  // Debt & Loans
  'debt-payoff-timeline': 'Debt Payoff Timeline',
  'loan-amortization': 'Loan Amortization Schedule',
  // Investment
  'investment-performance': 'Investment Performance',
  'dividend-income': 'Dividend & Interest Income',
  // Behavioral Insights
  'recurring-expenses': 'Recurring Expenses Tracker',
  'spending-anomalies': 'Spending Anomalies',
  'weekend-weekday-spending': 'Weekend vs Weekday Spending',
  // Maintenance & Cleanup
  'uncategorized-transactions': 'Uncategorized Transactions',
  'duplicate-transactions': 'Duplicate Transaction Finder',
  // Scheduled & Bills
  'upcoming-bills': 'Upcoming Bills Calendar',
  'bill-payment-history': 'Bill Payment History',
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
  const params = useParams();
  const reportId = params.reportId as string;

  const ReportComponent = reportComponents[reportId];
  const reportName = reportNames[reportId];

  if (!ReportComponent) {
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
        <AppHeader />
        <div className="px-4 sm:px-6 lg:px-12 py-8">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-8 text-center">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-2">
              Report Not Found
            </h1>
            <p className="text-gray-500 dark:text-gray-400">
              The requested report does not exist.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <AppHeader />

      {/* Page Header */}
      <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50">
        <div className="px-4 sm:px-6 lg:px-12 py-6">
          <div className="flex items-center gap-4">
            <a
              href="/reports"
              className="text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </a>
            <div>
              <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">{reportName}</h1>
            </div>
          </div>
        </div>
      </div>

      <div className="px-4 sm:px-6 lg:px-12 py-8">
        <Suspense fallback={<ReportSkeleton />}>
          <ReportComponent />
        </Suspense>
      </div>
    </div>
  );
}
