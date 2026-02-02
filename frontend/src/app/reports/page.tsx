'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { AppHeader } from '@/components/layout/AppHeader';
import { useLocalStorage } from '@/hooks/useLocalStorage';

type DensityLevel = 'normal' | 'compact' | 'dense';

interface Report {
  id: string;
  name: string;
  description: string;
  icon: React.ReactNode;
  category: 'spending' | 'income' | 'networth' | 'tax';
  color: string;
}

const reports: Report[] = [
  {
    id: 'spending-by-category',
    name: 'Spending by Category',
    description: 'See where your money goes with a breakdown of expenses by category over time.',
    category: 'spending',
    color: 'bg-blue-500',
    icon: (
      <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M11 3.055A9.001 9.001 0 1020.945 13H11V3.055z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M20.488 9H15V3.512A9.025 9.025 0 0120.488 9z" />
      </svg>
    ),
  },
  {
    id: 'spending-by-payee',
    name: 'Spending by Payee',
    description: 'Track how much you spend with each merchant or vendor over time.',
    category: 'spending',
    color: 'bg-indigo-500',
    icon: (
      <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    ),
  },
  {
    id: 'monthly-spending-trend',
    name: 'Monthly Spending Trend',
    description: 'View your spending patterns month over month to identify trends.',
    category: 'spending',
    color: 'bg-purple-500',
    icon: (
      <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 17h8m0 0V9m0 8l-8-8-4 4-6-6" />
      </svg>
    ),
  },
  {
    id: 'income-vs-expenses',
    name: 'Income vs Expenses',
    description: 'Compare your income to expenses and track your savings rate over time.',
    category: 'income',
    color: 'bg-green-500',
    icon: (
      <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 6l3 1m0 0l-3 9a5.002 5.002 0 006.001 0M6 7l3 9M6 7l6-2m6 2l3-1m-3 1l-3 9a5.002 5.002 0 006.001 0M18 7l3 9m-3-9l-6-2m0-2v2m0 16V5m0 16H9m3 0h3" />
      </svg>
    ),
  },
  {
    id: 'income-by-source',
    name: 'Income by Source',
    description: 'Break down your income streams to understand where your money comes from.',
    category: 'income',
    color: 'bg-emerald-500',
    icon: (
      <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
      </svg>
    ),
  },
  {
    id: 'net-worth',
    name: 'Net Worth Over Time',
    description: 'Track your total net worth including all accounts, assets, and liabilities.',
    category: 'networth',
    color: 'bg-teal-500',
    icon: (
      <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
      </svg>
    ),
  },
  {
    id: 'account-balances',
    name: 'Account Balances',
    description: 'View balance history for all your accounts over a selected time period.',
    category: 'networth',
    color: 'bg-cyan-500',
    icon: (
      <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
      </svg>
    ),
  },
  {
    id: 'cash-flow',
    name: 'Cash Flow Statement',
    description: 'Detailed view of money coming in and going out across all accounts.',
    category: 'income',
    color: 'bg-sky-500',
    icon: (
      <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M7 16V4m0 0L3 8m4-4l4 4m6 0v12m0 0l4-4m-4 4l-4-4" />
      </svg>
    ),
  },
  {
    id: 'tax-summary',
    name: 'Tax Summary',
    description: 'Annual summary of tax-deductible expenses and taxable income.',
    category: 'tax',
    color: 'bg-red-500',
    icon: (
      <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z" />
      </svg>
    ),
  },
  {
    id: 'year-over-year',
    name: 'Year Over Year Comparison',
    description: 'Compare this year to previous years to track financial progress.',
    category: 'spending',
    color: 'bg-violet-500',
    icon: (
      <svg className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
      </svg>
    ),
  },
];

const categoryLabels: Record<Report['category'], string> = {
  spending: 'Spending',
  income: 'Income',
  networth: 'Net Worth',
  tax: 'Tax',
};

const categoryColors: Record<Report['category'], string> = {
  spending: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  income: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  networth: 'bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300',
  tax: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300',
};

export default function ReportsPage() {
  const router = useRouter();
  const [density, setDensity] = useLocalStorage<DensityLevel>('moneymate-reports-density', 'normal');
  const [categoryFilter, setCategoryFilter] = useState<Report['category'] | 'all'>('all');

  const cycleDensity = () => {
    const levels: DensityLevel[] = ['normal', 'compact', 'dense'];
    const currentIndex = levels.indexOf(density);
    const nextIndex = (currentIndex + 1) % levels.length;
    setDensity(levels[nextIndex]);
  };

  const densityLabels: Record<DensityLevel, string> = {
    normal: 'Normal',
    compact: 'Compact',
    dense: 'Dense',
  };

  const filteredReports = categoryFilter === 'all'
    ? reports
    : reports.filter(r => r.category === categoryFilter);

  const handleReportClick = (reportId: string) => {
    router.push(`/reports/${reportId}`);
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      <AppHeader />

      {/* Page Header */}
      <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50">
        <div className="px-4 sm:px-6 lg:px-12 py-6">
          <div className="flex justify-between items-center">
            <div>
              <h1 className="text-3xl font-bold text-gray-900 dark:text-gray-100">Reports</h1>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Generate insights about your financial health
              </p>
            </div>
            <button
              onClick={cycleDensity}
              className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-gray-700 rounded-md hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
              title={`Switch to ${densityLabels[density === 'normal' ? 'compact' : density === 'compact' ? 'dense' : 'normal']} view`}
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
              </svg>
              {densityLabels[density]}
            </button>
          </div>
        </div>
      </div>

      <div className="px-4 sm:px-6 lg:px-12 py-8">
        {/* Category Filter */}
        <div className="mb-6 flex flex-wrap gap-2">
          <button
            onClick={() => setCategoryFilter('all')}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
              categoryFilter === 'all'
                ? 'bg-blue-600 text-white'
                : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-300 dark:border-gray-600'
            }`}
          >
            All Reports
          </button>
          {(Object.keys(categoryLabels) as Report['category'][]).map((cat) => (
            <button
              key={cat}
              onClick={() => setCategoryFilter(cat)}
              className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${
                categoryFilter === cat
                  ? 'bg-blue-600 text-white'
                  : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 border border-gray-300 dark:border-gray-600'
              }`}
            >
              {categoryLabels[cat]}
            </button>
          ))}
        </div>

        {/* Reports Grid */}
        {density === 'normal' && (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {filteredReports.map((report) => (
              <button
                key={report.id}
                onClick={() => handleReportClick(report.id)}
                className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden hover:shadow-lg dark:hover:shadow-gray-700/70 transition-shadow text-left group flex flex-col h-full"
              >
                {/* Preview Area */}
                <div className={`h-32 ${report.color} bg-opacity-10 dark:bg-opacity-20 flex items-center justify-center relative flex-shrink-0`}>
                  <div className={`${report.color} bg-opacity-20 dark:bg-opacity-30 rounded-full p-4`}>
                    <div className="text-gray-700 dark:text-gray-200">
                      {report.icon}
                    </div>
                  </div>
                  <span className={`absolute top-3 right-3 px-2 py-1 text-xs font-medium rounded ${categoryColors[report.category]}`}>
                    {categoryLabels[report.category]}
                  </span>
                </div>
                {/* Content */}
                <div className="p-4 flex flex-col flex-1">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                    {report.name}
                  </h3>
                  <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                    {report.description}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}

        {density === 'compact' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredReports.map((report) => (
              <button
                key={report.id}
                onClick={() => handleReportClick(report.id)}
                className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4 hover:shadow-md dark:hover:shadow-gray-700/70 transition-shadow text-left flex items-center gap-4 group"
              >
                <div className={`${report.color} bg-opacity-20 dark:bg-opacity-30 rounded-lg p-3 flex-shrink-0`}>
                  <div className="text-gray-700 dark:text-gray-200">
                    {report.icon}
                  </div>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors truncate">
                      {report.name}
                    </h3>
                    <span className={`px-2 py-0.5 text-xs font-medium rounded ${categoryColors[report.category]} flex-shrink-0`}>
                      {categoryLabels[report.category]}
                    </span>
                  </div>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 line-clamp-1">
                    {report.description}
                  </p>
                </div>
              </button>
            ))}
          </div>
        )}

        {density === 'dense' && (
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
            <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
              <thead className="bg-gray-50 dark:bg-gray-900/50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Report
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                    Category
                  </th>
                  <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden md:table-cell">
                    Description
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {filteredReports.map((report) => (
                  <tr
                    key={report.id}
                    onClick={() => handleReportClick(report.id)}
                    className="hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <div className={`${report.color} bg-opacity-20 dark:bg-opacity-30 rounded p-1.5 flex-shrink-0 flex items-center justify-center`}>
                          <div className="text-gray-700 dark:text-gray-200 [&>svg]:h-5 [&>svg]:w-5">
                            {report.icon}
                          </div>
                        </div>
                        <span className="font-medium text-gray-900 dark:text-gray-100">
                          {report.name}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2 py-0.5 text-xs font-medium rounded ${categoryColors[report.category]}`}>
                        {categoryLabels[report.category]}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-sm text-gray-500 dark:text-gray-400 hidden md:table-cell">
                      {report.description}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Report Count */}
        <div className="mt-6 text-sm text-gray-500 dark:text-gray-400 text-center">
          {filteredReports.length} report{filteredReports.length !== 1 ? 's' : ''} available
        </div>
      </div>
    </div>
  );
}
