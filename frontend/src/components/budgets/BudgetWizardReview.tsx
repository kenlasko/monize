'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { gainLossColor, roundMoney, sumMoney } from '@/lib/format';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { budgetsApi } from '@/lib/budgets';
import { useNumberFormat } from '@/hooks/useNumberFormat';
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
  const t = useTranslations('budgets');
  const { formatCurrency } = useNumberFormat();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const incomeCategories = Array.from(state.selectedCategories.values()).filter(
    (c) => c.isIncome,
  );
  const expenseCategories = Array.from(
    state.selectedCategories.values(),
  ).filter((c) => !c.isIncome);

  const transferEntries = Array.from(state.selectedTransfers.values());

  const totalIncome = sumMoney(incomeCategories.map((c) => c.amount));
  const totalExpenses = sumMoney(expenseCategories.map((c) => c.amount));
  const totalTransfers = sumMoney(transferEntries.map((t) => t.amount));
  const net = roundMoney(totalIncome - totalExpenses - totalTransfers);

  const unknownLabel = 'Unknown';

  const getCategoryName = (categoryId?: string): string => {
    if (!categoryId) return unknownLabel;
    const cat = state.analysisResult?.categories.find(
      (c) => c.categoryId === categoryId,
    );
    return cat?.categoryName ?? unknownLabel;
  };

  const getTransferName = (accountId?: string): string => {
    if (!accountId) return t('wizardReview.categoryTypes.transfer');
    const transfer = state.analysisResult?.transfers?.find(
      (tr) => tr.accountId === accountId,
    );
    return transfer?.accountName ?? t('wizardReview.categoryTypes.transfer');
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
      toast.success(t('wizardReview.toasts.created'));
      onComplete();
    } catch (error) {
      toast.error(getErrorMessage(error, t('wizardReview.toasts.failed')));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="space-y-6">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t('wizardReview.title')}
      </h3>

      {/* Budget details */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <dl className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <div>
            <dt className="text-sm text-gray-500 dark:text-gray-400">{t('wizardReview.fields.name')}</dt>
            <dd className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {state.budgetName}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-gray-500 dark:text-gray-400">{t('wizardReview.fields.type')}</dt>
            <dd className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {BUDGET_TYPE_LABELS[state.budgetType] ?? state.budgetType}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-gray-500 dark:text-gray-400">
              {t('wizardReview.fields.strategy')}
            </dt>
            <dd className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {state.strategy ? (STRATEGY_LABELS[state.strategy] ?? state.strategy) : t('wizardReview.strategyNotSelected')}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-gray-500 dark:text-gray-400">
              {t('wizardReview.fields.startDate')}
            </dt>
            <dd className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {state.periodStart}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-gray-500 dark:text-gray-400">
              {t('wizardReview.fields.rollover')}
            </dt>
            <dd className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {state.defaultRolloverType === 'NONE' ? t('wizardReview.rolloverOff') : state.defaultRolloverType.charAt(0) + state.defaultRolloverType.slice(1).toLowerCase()}
            </dd>
          </div>
          <div>
            <dt className="text-sm text-gray-500 dark:text-gray-400">
              {t('wizardReview.fields.alerts')}
            </dt>
            <dd className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {t('wizardReview.alertsValue', { warn: String(state.alertWarnPercent), critical: String(state.alertCriticalPercent) })}
            </dd>
          </div>
          {state.incomeLinked && state.baseIncome && (
            <div>
              <dt className="text-sm text-gray-500 dark:text-gray-400">
                {t('wizardReview.fields.incomeLinked')}
              </dt>
              <dd className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {formatCurrency(state.baseIncome, state.currencyCode)}/mo
              </dd>
            </div>
          )}
          {state.excludedAccountIds.length > 0 && (
            <div>
              <dt className="text-sm text-gray-500 dark:text-gray-400">
                {t('wizardReview.fields.excludedAccounts')}
              </dt>
              <dd className="text-sm font-medium text-gray-900 dark:text-gray-100">
                {t('wizardReview.accountCount', { count: state.excludedAccountIds.length })}
              </dd>
            </div>
          )}
        </dl>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4">
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 text-center">
          <div className="text-sm text-gray-500 dark:text-gray-400">
            {t('wizardReview.summaryCards.estIncome')}
          </div>
          <div className="text-lg sm:text-xl font-bold text-green-600 dark:text-green-400">
            {formatCurrency(totalIncome, state.currencyCode)}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 text-center">
          <div className="text-sm text-gray-500 dark:text-gray-400">
            {t('wizardReview.summaryCards.totalExpenses')}
          </div>
          <div className="text-lg sm:text-xl font-bold text-gray-900 dark:text-gray-100">
            {formatCurrency(totalExpenses, state.currencyCode)}
          </div>
          <div className="text-xs text-gray-400 dark:text-gray-500">
            {t('wizardReview.categoryCount', { count: expenseCategories.length })}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 text-center">
          <div className="text-sm text-gray-500 dark:text-gray-400">
            {t('wizardReview.summaryCards.transfers')}
          </div>
          <div className="text-lg sm:text-xl font-bold text-blue-600 dark:text-blue-400">
            {formatCurrency(totalTransfers, state.currencyCode)}
          </div>
          <div className="text-xs text-gray-400 dark:text-gray-500">
            {t('wizardReview.accountsCount', { count: transferEntries.length })}
          </div>
        </div>
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-4 text-center">
          <div className="text-sm text-gray-500 dark:text-gray-400">
            {t('wizardReview.summaryCards.remaining')}
          </div>
          <div
            className={`text-lg sm:text-xl font-bold ${
              gainLossColor(net)
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
                {t('wizardReview.tableHeaders.category')}
              </th>
              <th className="text-right py-2 px-2 sm:px-4 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                {t('wizardReview.tableHeaders.amount')}
              </th>
              <th className="hidden sm:table-cell text-right py-2 px-4 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                {t('wizardReview.tableHeaders.type')}
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
                  {t('wizardReview.categoryTypes.income')}
                </td>
              </tr>
            ))}
            {expenseCategories
              .sort((a, b) => b.amount - a.amount)
              .map((cat, idx) => (
                <tr
                  key={cat.categoryId ?? `__expense-${idx}`}
                  className="border-b border-gray-100 dark:border-gray-700 last:border-0"
                >
                  <td className="py-2 px-2 sm:px-4 text-sm text-gray-900 dark:text-gray-100">
                    {getCategoryName(cat.categoryId)}
                  </td>
                  <td className="py-2 px-2 sm:px-4 text-sm text-right text-gray-900 dark:text-gray-100">
                    {formatCurrency(cat.amount, state.currencyCode)}
                  </td>
                  <td className="hidden sm:table-cell py-2 px-4 text-sm text-right text-gray-500 dark:text-gray-400">
                    {t('wizardReview.categoryTypes.expense')}
                  </td>
                </tr>
              ))}
            {transferEntries
              .sort((a, b) => b.amount - a.amount)
              .map((entry) => (
                <tr
                  key={entry.transferAccountId}
                  className="border-b border-gray-100 dark:border-gray-700 last:border-0"
                >
                  <td className="py-2 px-2 sm:px-4 text-sm text-gray-900 dark:text-gray-100">
                    {getTransferName(entry.transferAccountId)}
                  </td>
                  <td className="py-2 px-2 sm:px-4 text-sm text-right text-blue-600 dark:text-blue-400">
                    {formatCurrency(entry.amount, state.currencyCode)}
                  </td>
                  <td className="hidden sm:table-cell py-2 px-4 text-sm text-right text-blue-500 dark:text-blue-400">
                    {t('wizardReview.categoryTypes.transfer')}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {/* Actions */}
      <div className="flex justify-between pt-4 border-t border-gray-200 dark:border-gray-700">
        <Button variant="outline" onClick={onBack} disabled={isSubmitting}>
          {t('wizard.back')}
        </Button>
        <Button onClick={handleCreate} isLoading={isSubmitting}>
          {t('wizardReview.createButton')}
        </Button>
      </div>
    </div>
  );
}
