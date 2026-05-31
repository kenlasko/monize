'use client';

import { useState, useMemo } from 'react';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { exportToCsv } from '@/lib/csv-export';
import { ExportDropdown } from '@/components/ui/ExportDropdown';
import { useReportData } from '@/hooks/useReportData';
import { ReportError } from '@/components/reports/ReportError';

export function TaxSummaryReport() {
  const { formatCurrency } = useNumberFormat();
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());

  const years = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return Array.from({ length: 5 }, (_, i) => currentYear - i);
  }, []);

  const { data: taxData, isLoading, error, reload } = useReportData(
    () => builtInReportsApi.getTaxSummary(selectedYear),
    [selectedYear],
  );

  if (error) {
    return <ReportError onRetry={reload} />;
  }

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="space-y-4">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  const incomeBySource = taxData?.incomeBySource ?? [];
  const deductibleExpenses = taxData?.deductibleExpenses ?? [];
  const allExpenses = taxData?.allExpenses ?? [];
  const totals = taxData?.totals ?? { income: 0, expenses: 0, deductible: 0 };

  const getExportData = () => {
    const headers = ['Section', 'Category', 'Amount'];
    const rows: (string | number)[][] = [];
    for (const item of incomeBySource) {
      rows.push(['Income', item.name, item.total]);
    }
    for (const item of deductibleExpenses) {
      rows.push(['Potential Deductions', item.name, item.total]);
    }
    for (const item of allExpenses) {
      rows.push(['Expenses', item.name, item.total]);
    }
    return { headers, rows };
  };

  const handleExportCsv = () => {
    const { headers, rows } = getExportData();
    rows.push(['Totals', 'Total Income', totals.income]);
    rows.push(['Totals', 'Total Expenses', totals.expenses]);
    rows.push(['Totals', 'Total Deductions', totals.deductible]);
    exportToCsv(`tax-summary-${selectedYear}`, headers, rows);
  };

  const handleExportPdf = async () => {
    const { exportToPdf } = await import('@/lib/pdf-export');
    const { headers, rows } = getExportData();
    const totalRow: (string | number)[] = ['Totals', 'Total Income / Expenses / Deductions', `${formatCurrency(totals.income)} / ${formatCurrency(totals.expenses)} / ${formatCurrency(totals.deductible)}`];
    await exportToPdf({
      title: `Tax Summary - ${selectedYear}`,
      subtitle: `Income: ${formatCurrency(totals.income)} | Expenses: ${formatCurrency(totals.expenses)} | Deductions: ${formatCurrency(totals.deductible)}`,
      tableData: { headers, rows, totalRow },
      filename: `tax-summary-${selectedYear}`,
    });
  };

  return (
    <div className="space-y-6">
      {/* Year Selector */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300 whitespace-nowrap">
              Tax Year:
            </label>
            <select
              value={selectedYear}
              onChange={(e) => setSelectedYear(Number(e.target.value))}
              className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
            >
              {years.map((year) => (
                <option key={year} value={year}>{year}</option>
              ))}
            </select>
          </div>
          <ExportDropdown onExportCsv={handleExportCsv} onExportPdf={handleExportPdf} />
        </div>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="text-sm text-gray-500 dark:text-gray-400">Total Income</div>
          <div className="text-2xl font-bold text-green-600 dark:text-green-400">
            {formatCurrency(totals.income)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="text-sm text-gray-500 dark:text-gray-400">Total Expenses</div>
          <div className="text-2xl font-bold text-red-600 dark:text-red-400">
            {formatCurrency(totals.expenses)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="text-sm text-gray-500 dark:text-gray-400">Potential Deductions</div>
          <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">
            {formatCurrency(totals.deductible)}
          </div>
        </div>
      </div>

      {/* Notice */}
      <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
        <div className="flex gap-3">
          <svg className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
          </svg>
          <div className="text-sm text-amber-800 dark:text-amber-200">
            <p className="font-medium">For Reference Only</p>
            <p className="mt-1">
              This summary is based on automatic category detection and may not include all tax-relevant
              transactions. Consult a tax professional for accurate tax preparation.
            </p>
          </div>
        </div>
      </div>

      {/* Income Breakdown */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
        <div className="px-6 py-4 bg-green-50 dark:bg-green-900/20 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-green-700 dark:text-green-300">
            Income by Source
          </h3>
        </div>
        <div className="divide-y divide-gray-200 dark:divide-gray-700">
          {incomeBySource.length === 0 ? (
            <p className="px-6 py-4 text-gray-500 dark:text-gray-400">No income recorded for {selectedYear}</p>
          ) : (
            incomeBySource.map((item, index) => (
              <div key={index} className="px-6 py-3 flex items-center justify-between">
                <span className="text-gray-900 dark:text-gray-100">{item.name}</span>
                <span className="font-medium text-green-600 dark:text-green-400">
                  {formatCurrency(item.total)}
                </span>
              </div>
            ))
          )}
        </div>
        {incomeBySource.length > 0 && (
          <div className="px-6 py-3 bg-gray-50 dark:bg-gray-900/50 flex items-center justify-between font-semibold">
            <span className="text-gray-900 dark:text-gray-100">Total Income</span>
            <span className="text-green-600 dark:text-green-400">
              {formatCurrency(totals.income)}
            </span>
          </div>
        )}
      </div>

      {/* Potential Deductions */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
        <div className="px-6 py-4 bg-blue-50 dark:bg-blue-900/20 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-blue-700 dark:text-blue-300">
            Potentially Tax-Deductible Expenses
          </h3>
        </div>
        <div className="divide-y divide-gray-200 dark:divide-gray-700">
          {deductibleExpenses.length === 0 ? (
            <p className="px-6 py-4 text-gray-500 dark:text-gray-400">
              No potentially deductible expenses detected. Categories containing keywords like
              "medical", "donation", "education", "childcare", or "RRSP" will appear here.
            </p>
          ) : (
            deductibleExpenses.map((item, index) => (
              <div key={index} className="px-6 py-3 flex items-center justify-between">
                <span className="text-gray-900 dark:text-gray-100">{item.name}</span>
                <span className="font-medium text-blue-600 dark:text-blue-400">
                  {formatCurrency(item.total)}
                </span>
              </div>
            ))
          )}
        </div>
        {deductibleExpenses.length > 0 && (
          <div className="px-6 py-3 bg-gray-50 dark:bg-gray-900/50 flex items-center justify-between font-semibold">
            <span className="text-gray-900 dark:text-gray-100">Total Potential Deductions</span>
            <span className="text-blue-600 dark:text-blue-400">
              {formatCurrency(totals.deductible)}
            </span>
          </div>
        )}
      </div>

      {/* All Expenses by Category */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
        <div className="px-6 py-4 bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-700 dark:text-gray-300">
            All Expenses by Category
          </h3>
        </div>
        <div className="divide-y divide-gray-200 dark:divide-gray-700 max-h-96 overflow-y-auto">
          {allExpenses.map((item, index) => (
            <div key={index} className="px-6 py-3 flex items-center justify-between">
              <span className="text-gray-900 dark:text-gray-100">{item.name}</span>
              <span className="font-medium text-gray-600 dark:text-gray-400">
                {formatCurrency(item.total)}
              </span>
            </div>
          ))}
        </div>
        <div className="px-6 py-3 bg-gray-50 dark:bg-gray-900/50 flex items-center justify-between font-semibold border-t border-gray-200 dark:border-gray-700">
          <span className="text-gray-900 dark:text-gray-100">Total Expenses</span>
          <span className="text-red-600 dark:text-red-400">
            {formatCurrency(totals.expenses)}
          </span>
        </div>
      </div>
    </div>
  );
}
