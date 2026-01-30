'use client';

import { useParams } from 'next/navigation';
import { AppHeader } from '@/components/layout/AppHeader';
import { SpendingByCategoryReport } from '@/components/reports/SpendingByCategoryReport';
import { SpendingByPayeeReport } from '@/components/reports/SpendingByPayeeReport';
import { MonthlySpendingTrendReport } from '@/components/reports/MonthlySpendingTrendReport';
import { IncomeVsExpensesReport } from '@/components/reports/IncomeVsExpensesReport';
import { IncomeBySourceReport } from '@/components/reports/IncomeBySourceReport';
import { NetWorthReport } from '@/components/reports/NetWorthReport';
import { AccountBalancesReport } from '@/components/reports/AccountBalancesReport';
import { CashFlowReport } from '@/components/reports/CashFlowReport';
import { TaxSummaryReport } from '@/components/reports/TaxSummaryReport';
import { YearOverYearReport } from '@/components/reports/YearOverYearReport';

const reportComponents: Record<string, React.ComponentType> = {
  'spending-by-category': SpendingByCategoryReport,
  'spending-by-payee': SpendingByPayeeReport,
  'monthly-spending-trend': MonthlySpendingTrendReport,
  'income-vs-expenses': IncomeVsExpensesReport,
  'income-by-source': IncomeBySourceReport,
  'net-worth': NetWorthReport,
  'account-balances': AccountBalancesReport,
  'cash-flow': CashFlowReport,
  'tax-summary': TaxSummaryReport,
  'year-over-year': YearOverYearReport,
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
};

export default function ReportPage() {
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
        <ReportComponent />
      </div>
    </div>
  );
}
