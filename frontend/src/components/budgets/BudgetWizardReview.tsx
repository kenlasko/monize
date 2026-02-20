'use client';

import { useState } from 'react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { budgetsApi } from '@/lib/budgets';
import { formatCurrency } from '@/lib/format';
import { getErrorMessage } from '@/lib/errors';
import { STRATEGY_LABELS, BUDGET_TYPE_LABELS } from './utils/budget-labels';
import type { WizardState } from './BudgetWizard';

interface BudgetWizardReviewProps {
  state: WizardState;
  updateState: (updates: Partial<WizardState>) => void;
  onComplete: () => void;
  onBack: () => void;
}

export function BudgetWizardReview({
  state,
  onComplete,
  onBack,
}: BudgetWizardReviewProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  const incomeCategories = Array.from(state.selectedCategories.values()).filter(
    (c) => c.isIncome,
  );
  const expenseCategories = Array.from(
    state.selectedCategories.values(),
  ).filter((c) => !c.isIncome);

  const transferEntries = Array.from(state.selectedTransfers.values());

  const totalIncome = incomeCategories.reduce((sum, c) => sum + c.amount, 0);
  const totalExpenses = expenseCategories.reduce((sum, c) => sum + c.amount, 0);
  const totalTransfers = transferEntries.reduce((sum, t) => sum + t.amount, 0);
  const net = totalIncome - totalExpenses - totalTransfers;

  const getCategoryName = (categoryId?: string): string => {
    if (!categoryId) return 'Unknown';
    const cat = state.analysisResult?.categories.find(
      (c) => c.categoryId === categoryId,
    );
    return cat?.categoryName ?? 'Unknown';
  };

  const getTransferName = (accountId?: string): string => {
    if (!accountId) return 'Transfer';
    const t = state.analysisResult?.transfers?.find(
      (tr) => tr.accountId === accountId,
    );
    return t?.accountName ?? 'Transfer';
  };

  const handleCreate = async () => {
    setIsSubmitting(true);
    try {
      const allCategories = [
        ...Array.from(state.selectedCategories.values()),
        ...transferEntries,
      ];

      const config: Record<string, unknown> = {};
      if (state.excludedAccountIds.length > 0) {
        config.excludedAccountIds = state.excludedAccountIds;
      }

      await budgetsApi.applyGenerated({
        name: state.budgetName,
        budgetType: state.budgetType,
        periodStart: state.periodStart,
        strategy: state.strategy ?? undefined,
        currencyCode: state.currencyCode,
        baseIncome: state.baseIncome ?? undefined,
        incomeLinked: state.incomeLinked,
        config: Object.keys(config).length > 0 ? config : undefined,
        categories: allCategories,
      });
      toast.success('Budget created successfully');
      onComplete();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to create budget'));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        Review Your Budget
      </h3>

      {/* Budget details */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <div>
            <dt className="text-sm text-gray-500 dark:text-gray-400">Name</dt>
            <dd className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {state.budgetName}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-gray-500 dark:text-gray-400">Type</dt>
            <dd className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {BUDGET_TYPE_LABELS[state.budgetType] ?? state.budgetType}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-gray-500 dark:text-gray-400">
              Strategy
            </dt>
            <dd className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {state.strategy ? (STRATEGY_LABELS[state.strategy] ?? state.strategy) : 'Not selected'}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-gray-500 dark:text-gray-400">
              Start Date
            </dt>
            <dd className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {state.periodStart}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-gray-500 dark:text-gray-400">
              Rollover
            </dt>
            <dd className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {state.defaultRolloverType === 'NONE' ? 'Off' : state.defaultRolloverType.charAt(0) + state.defaultRolloverType.slice(1).toLowerCase()}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-gray-500 dark:text-gray-400">
              Alerts
            </dt>
            <dd className="text-sm font-medium text-gray-900 dark:text-gray-100">
              Warn {state.alertWarnPercent}% / Critical {state.alertCriticalPercent}%
            </dd>
          </div>
          {state.incomeLinked && state.baseIncome && (
            <div>
              <dt className="text-sm text-gray-500 dark:text-gray-400">
                Income Linked
              </dt>
              <dd className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {formatCurrency(state.baseIncome, state.currencyCode)}/mo
              </dd>
            </div>
          )}
          {state.excludedAccountIds.length > 0 && (
            <div>
              <dt className="text-sm text-gray-500 dark:text-gray-400">
                Excluded Accounts
              </dt>
              <dd className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {state.excludedAccountIds.length} account{state.excludedAccountIds.length === 1 ? '' : 's'}
              </dd>
            </div>
          )}
        </dl>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 text-center">
          <div className="text-sm text-gray-500 dark:text-gray-400">
            Est. Income
          </div>
          <div className="text-lg sm:text-xl font-bold text-green-600 dark:text-green-400">
            {formatCurrency(totalIncome, state.currencyCode)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 text-center">
          <div className="text-sm text-gray-500 dark:text-gray-400">
            Total Expenses
          </div>
          <div className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            {formatCurrency(totalExpenses, state.currencyCode)}
          </div>
          <div className="text-xs text-gray-400 dark:text-gray-500">
            {expenseCategories.length} categories
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 text-center">
          <div className="text-sm text-gray-500 dark:text-gray-400">
            Transfers
          </div>
          <div className="text-lg sm:text-xl font-bold text-blue-600 dark:text-blue-400">
            {formatCurrency(totalTransfers, state.currencyCode)}
          </div>
          <div className="text-xs text-gray-400 dark:text-gray-500">
            {transferEntries.length} accounts
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 text-center">
          <div className="text-sm text-gray-500 dark:text-gray-400">
            Remaining
          </div>
          <div
            className={`text-lg sm:text-xl font-bold ${
              net >= 0
                ? 'text-green-600 dark:text-green-400'
                : 'text-red-600 dark:text-red-400'
            }`}
          >
            {formatCurrency(net, state.currencyCode)}
          </div>
        </div>
      </div>

      {/* Category list */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="bg-gray-100 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700">
              <th className="text-left py-2 px-2 sm:px-4 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                Category
              </th>
              <th className="text-right py-2 px-2 sm:px-4 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                Amount
              </th>
              <th className="hidden sm:table-cell text-right py-2 px-4 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                Type
              </th>
            </tr>
          </thead>
          <tbody>
            {incomeCategories.map((cat) => (
              <tr
                key={cat.categoryId}
                className="border-b border-gray-100 dark:border-gray-700 last:border-0"
              >
                <td className="py-2 px-2 sm:px-4 text-sm text-gray-900 dark:text-gray-100">
                  {getCategoryName(cat.categoryId)}
                </td>
                <td className="py-2 px-2 sm:px-4 text-sm text-right text-green-600 dark:text-green-400">
                  {formatCurrency(cat.amount, state.currencyCode)}
                </td>
                <td className="hidden sm:table-cell py-2 px-4 text-sm text-right text-gray-500 dark:text-gray-400">
                  Income
                </td>
              </tr>
            ))}
            {expenseCategories
              .sort((a, b) => b.amount - a.amount)
              .map((cat) => (
                <tr
                  key={cat.categoryId}
                  className="border-b border-gray-100 dark:border-gray-700 last:border-0"
                >
                  <td className="py-2 px-2 sm:px-4 text-sm text-gray-900 dark:text-gray-100">
                    {getCategoryName(cat.categoryId)}
                  </td>
                  <td className="py-2 px-2 sm:px-4 text-sm text-right text-gray-900 dark:text-gray-100">
                    {formatCurrency(cat.amount, state.currencyCode)}
                  </td>
                  <td className="hidden sm:table-cell py-2 px-4 text-sm text-right text-gray-500 dark:text-gray-400">
                    Expense
                  </td>
                </tr>
              ))}
            {transferEntries
              .sort((a, b) => b.amount - a.amount)
              .map((t) => (
                <tr
                  key={t.transferAccountId}
                  className="border-b border-gray-100 dark:border-gray-700 last:border-0"
                >
                  <td className="py-2 px-2 sm:px-4 text-sm text-gray-900 dark:text-gray-100">
                    {getTransferName(t.transferAccountId)}
                  </td>
                  <td className="py-2 px-2 sm:px-4 text-sm text-right text-blue-600 dark:text-blue-400">
                    {formatCurrency(t.amount, state.currencyCode)}
                  </td>
                  <td className="hidden sm:table-cell py-2 px-4 text-sm text-right text-blue-500 dark:text-blue-400">
                    Transfer
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {/* Actions */}
      <div className="flex justify-between pt-4 border-t border-gray-200 dark:border-gray-700">
        <Button variant="outline" onClick={onBack} disabled={isSubmitting}>
          Back
        </Button>
        <Button onClick={handleCreate} isLoading={isSubmitting}>
          Create Budget
        </Button>
      </div>
    </div>
  );
}
