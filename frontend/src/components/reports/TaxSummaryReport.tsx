'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { format, startOfYear, endOfYear, subYears } from 'date-fns';
import { transactionsApi } from '@/lib/transactions';
import { categoriesApi } from '@/lib/categories';
import { Transaction } from '@/types/transaction';
import { Category } from '@/types/category';
import { parseLocalDate } from '@/lib/utils';
import { useNumberFormat } from '@/hooks/useNumberFormat';

export function TaxSummaryReport() {
  const { formatCurrency } = useNumberFormat();
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());

  const years = useMemo(() => {
    const currentYear = new Date().getFullYear();
    return Array.from({ length: 5 }, (_, i) => currentYear - i);
  }, []);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const yearStart = format(startOfYear(new Date(selectedYear, 0, 1)), 'yyyy-MM-dd');
      const yearEnd = format(endOfYear(new Date(selectedYear, 0, 1)), 'yyyy-MM-dd');

      const [txData, catData] = await Promise.all([
        transactionsApi.getAll({ startDate: yearStart, endDate: yearEnd, limit: 50000 }),
        categoriesApi.getAll(),
      ]);
      setTransactions(txData.data);
      setCategories(catData);
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setIsLoading(false);
    }
  }, [selectedYear]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const taxData = useMemo(() => {
    const categoryLookup = new Map(categories.map((c) => [c.id, c]));

    // Define tax-relevant category keywords
    const taxDeductibleKeywords = [
      'medical', 'health', 'dental', 'vision', 'prescription', 'pharmacy',
      'donation', 'charity', 'charitable',
      'education', 'tuition', 'school', 'course', 'training',
      'childcare', 'daycare',
      'moving',
      'union', 'professional dues',
      'rrsp', 'retirement',
    ];

    const incomeKeywords = [
      'salary', 'wage', 'income', 'employment', 'paycheck',
      'freelance', 'consulting', 'contract',
      'dividend', 'interest', 'investment income',
      'rental', 'rent income',
      'pension', 'ei', 'benefits',
    ];

    const incomeBySource = new Map<string, number>();
    const deductibleExpenses = new Map<string, number>();
    const allExpensesByCategory = new Map<string, number>();
    let totalIncome = 0;
    let totalExpenses = 0;

    const matchesKeywords = (name: string, keywords: string[]): boolean => {
      const lowerName = name.toLowerCase();
      return keywords.some(keyword => lowerName.includes(keyword));
    };

    transactions.forEach((tx) => {
      if (tx.isTransfer) return;
      if (tx.account?.accountType === 'INVESTMENT') return;
      const amount = Number(tx.amount) || 0;

      const processTransaction = (catId: string | null, catObj: Category | null, amt: number) => {
        const cat = catId ? categoryLookup.get(catId) : catObj;
        const parentCat = cat?.parentId ? categoryLookup.get(cat.parentId) : null;
        const catName = parentCat?.name || cat?.name || 'Uncategorized';

        if (amt > 0) {
          // Income
          totalIncome += amt;
          const existing = incomeBySource.get(catName) || 0;
          incomeBySource.set(catName, existing + amt);
        } else {
          // Expense
          const expenseAmt = Math.abs(amt);
          totalExpenses += expenseAmt;

          const existingExp = allExpensesByCategory.get(catName) || 0;
          allExpensesByCategory.set(catName, existingExp + expenseAmt);

          // Check if potentially deductible
          if (matchesKeywords(catName, taxDeductibleKeywords)) {
            const existing = deductibleExpenses.get(catName) || 0;
            deductibleExpenses.set(catName, existing + expenseAmt);
          }
        }
      };

      if (tx.isSplit && tx.splits && tx.splits.length > 0) {
        tx.splits.forEach((split) => {
          if (split.transferAccountId) return;
          const splitAmt = Number(split.amount) || 0;
          processTransaction(split.categoryId || null, split.category || null, splitAmt);
        });
      } else {
        processTransaction(tx.categoryId || null, tx.category || null, amount);
      }
    });

    const totalDeductible = Array.from(deductibleExpenses.values()).reduce((sum, v) => sum + v, 0);

    return {
      incomeBySource: Array.from(incomeBySource.entries())
        .map(([name, total]) => ({ name, total }))
        .sort((a, b) => b.total - a.total),
      deductibleExpenses: Array.from(deductibleExpenses.entries())
        .map(([name, total]) => ({ name, total }))
        .sort((a, b) => b.total - a.total),
      allExpenses: Array.from(allExpensesByCategory.entries())
        .map(([name, total]) => ({ name, total }))
        .sort((a, b) => b.total - a.total),
      totalIncome,
      totalExpenses,
      totalDeductible,
    };
  }, [transactions, categories]);

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="animate-pulse space-y-4">
          <div className="h-8 bg-gray-200 dark:bg-gray-700 rounded w-1/3" />
          <div className="h-64 bg-gray-200 dark:bg-gray-700 rounded" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Year Selector */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex items-center gap-4">
          <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
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
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="text-sm text-gray-500 dark:text-gray-400">Total Income</div>
          <div className="text-2xl font-bold text-green-600 dark:text-green-400">
            {formatCurrency(taxData.totalIncome)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="text-sm text-gray-500 dark:text-gray-400">Total Expenses</div>
          <div className="text-2xl font-bold text-red-600 dark:text-red-400">
            {formatCurrency(taxData.totalExpenses)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <div className="text-sm text-gray-500 dark:text-gray-400">Potential Deductions</div>
          <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">
            {formatCurrency(taxData.totalDeductible)}
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
          {taxData.incomeBySource.length === 0 ? (
            <p className="px-6 py-4 text-gray-500 dark:text-gray-400">No income recorded for {selectedYear}</p>
          ) : (
            taxData.incomeBySource.map((item, index) => (
              <div key={index} className="px-6 py-3 flex items-center justify-between">
                <span className="text-gray-900 dark:text-gray-100">{item.name}</span>
                <span className="font-medium text-green-600 dark:text-green-400">
                  {formatCurrency(item.total)}
                </span>
              </div>
            ))
          )}
        </div>
        {taxData.incomeBySource.length > 0 && (
          <div className="px-6 py-3 bg-gray-50 dark:bg-gray-900/50 flex items-center justify-between font-semibold">
            <span className="text-gray-900 dark:text-gray-100">Total Income</span>
            <span className="text-green-600 dark:text-green-400">
              {formatCurrency(taxData.totalIncome)}
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
          {taxData.deductibleExpenses.length === 0 ? (
            <p className="px-6 py-4 text-gray-500 dark:text-gray-400">
              No potentially deductible expenses detected. Categories containing keywords like
              "medical", "donation", "education", "childcare", or "RRSP" will appear here.
            </p>
          ) : (
            taxData.deductibleExpenses.map((item, index) => (
              <div key={index} className="px-6 py-3 flex items-center justify-between">
                <span className="text-gray-900 dark:text-gray-100">{item.name}</span>
                <span className="font-medium text-blue-600 dark:text-blue-400">
                  {formatCurrency(item.total)}
                </span>
              </div>
            ))
          )}
        </div>
        {taxData.deductibleExpenses.length > 0 && (
          <div className="px-6 py-3 bg-gray-50 dark:bg-gray-900/50 flex items-center justify-between font-semibold">
            <span className="text-gray-900 dark:text-gray-100">Total Potential Deductions</span>
            <span className="text-blue-600 dark:text-blue-400">
              {formatCurrency(taxData.totalDeductible)}
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
          {taxData.allExpenses.map((item, index) => (
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
            {formatCurrency(taxData.totalExpenses)}
          </span>
        </div>
      </div>
    </div>
  );
}
