'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { DateInput } from '@/components/ui/DateInput';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { NumericInput } from '@/components/ui/NumericInput';
import { Select } from '@/components/ui/Select';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { STRATEGY_LABELS } from './utils/budget-labels';
import { getCurrencySymbol } from '@/lib/format';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { WizardState } from './BudgetWizard';
import type { RolloverType } from '@/types/budget';
import type { Account } from '@/types/account';

interface BudgetWizardStrategyProps {
  state: WizardState;
  updateState: (updates: Partial<WizardState>) => void;
  accounts?: Account[];
  onNext: () => void;
  onBack: () => void;
}

const BUDGET_TYPE_VALUES = ['MONTHLY', 'ANNUAL', 'PAY_PERIOD'] as const;
const ROLLOVER_VALUES = ['NONE', 'MONTHLY', 'QUARTERLY', 'ANNUAL'] as const;

export function BudgetWizardStrategy({
  state,
  updateState,
  accounts = [],
  onNext,
  onBack,
}: BudgetWizardStrategyProps) {
  const t = useTranslations('budgets');
  const { formatCurrency } = useNumberFormat();
  const [showFlexGroups, setShowFlexGroups] = useState(false);

  const hasErrors = !state.budgetName.trim() || !state.periodStart;

  const activeAccounts = useMemo(
    () => accounts.filter((a) => !a.isClosed),
    [accounts],
  );

  const expenseCategories = useMemo(() => {
    const result: Array<{ id: string; name: string; flexGroup: string | null }> = [];
    if (!state.analysisResult) return result;
    for (const cat of state.analysisResult.categories) {
      if (cat.isIncome) continue;
      const selected = state.selectedCategories.get(cat.categoryId);
      if (!selected) continue;
      result.push({
        id: cat.categoryId,
        name: cat.categoryName,
        flexGroup: selected.flexGroup ?? null,
      });
    }
    return result;
  }, [state.analysisResult, state.selectedCategories]);

  const handleRolloverChange = (rolloverType: string) => {
    const newRollover = rolloverType as RolloverType;

    // Apply default rollover to all selected categories
    const updatedCategories = new Map(state.selectedCategories);
    for (const [key, cat] of updatedCategories) {
      updatedCategories.set(key, { ...cat, rolloverType: newRollover });
    }
    const updatedTransfers = new Map(state.selectedTransfers);
    for (const [key, t] of updatedTransfers) {
      updatedTransfers.set(key, { ...t, rolloverType: newRollover });
    }
    updateState({
      defaultRolloverType: newRollover,
      selectedCategories: updatedCategories,
      selectedTransfers: updatedTransfers,
    });
  };

  const handleAlertDefaults = (field: 'alertWarnPercent' | 'alertCriticalPercent', value: number) => {
    // Apply alert defaults to all selected categories
    const updatedCategories = new Map(state.selectedCategories);
    for (const [key, cat] of updatedCategories) {
      updatedCategories.set(key, { ...cat, [field]: value });
    }
    const updatedTransfers = new Map(state.selectedTransfers);
    for (const [key, t] of updatedTransfers) {
      updatedTransfers.set(key, { ...t, [field]: value });
    }
    updateState({
      [field]: value,
      selectedCategories: updatedCategories,
      selectedTransfers: updatedTransfers,
    });
  };

  const handleIncomeLinkToggle = (checked: boolean) => {
    const income = state.baseIncome;
    if (income && income > 0) {
      // Convert category amounts between dollars and percentages
      const convert = (amount: number) => {
        if (checked) {
          // Dollar → percentage of income
          return Math.round((amount / income) * 10000) / 100;
        }
        // Percentage → dollar amount
        return Math.round((amount * income) / 100 * 100) / 100;
      };

      const updatedCategories = new Map(state.selectedCategories);
      for (const [key, cat] of updatedCategories) {
        if (!cat.isIncome) {
          updatedCategories.set(key, { ...cat, amount: convert(cat.amount) });
        }
      }
      const updatedTransfers = new Map(state.selectedTransfers);
      for (const [key, t] of updatedTransfers) {
        updatedTransfers.set(key, { ...t, amount: convert(t.amount) });
      }
      updateState({
        incomeLinked: checked,
        selectedCategories: updatedCategories,
        selectedTransfers: updatedTransfers,
      });
    } else {
      updateState({ incomeLinked: checked });
    }
  };

  const handleFlexGroupChange = (categoryId: string, flexGroup: string) => {
    const updated = new Map(state.selectedCategories);
    const existing = updated.get(categoryId);
    if (existing) {
      updated.set(categoryId, {
        ...existing,
        flexGroup: flexGroup.trim() || undefined,
      });
      updateState({ selectedCategories: updated });
    }
  };

  const handleExcludedAccountToggle = (accountId: string, excluded: boolean) => {
    const current = state.excludedAccountIds;
    const updated = excluded
      ? [...current, accountId]
      : current.filter((id) => id !== accountId);
    updateState({ excludedAccountIds: updated });
  };

  return (
    <div className="space-y-6">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        {t('wizardStrategy.title')}
      </h3>

      {/* Budget Details */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 space-y-4">
        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">
          {t('wizardStrategy.sections.budgetDetails')}
        </h4>

        <Input
          label={t('wizardStrategy.budgetNameLabel')}
          value={state.budgetName}
          onChange={(e) => updateState({ budgetName: e.target.value })}
          maxLength={255}
          error={
            !state.budgetName.trim()
              ? t('wizardStrategy.budgetNameRequired')
              : undefined
          }
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Select
            label={t('wizardStrategy.budgetTypeLabel')}
            value={state.budgetType}
            onChange={(e) =>
              updateState({
                budgetType: e.target.value as WizardState['budgetType'],
              })
            }
            options={BUDGET_TYPE_VALUES.map((v) => ({ value: v, label: t(`wizardStrategy.budgetTypeOptions.${v}`) }))}
          />

          <DateInput
            label={t('wizardStrategy.startDateLabel')}
            value={state.periodStart}
            onDateChange={(date) => updateState({ periodStart: date })}
            onChange={(e) => updateState({ periodStart: e.target.value })}
            error={
              !state.periodStart ? t('wizardStrategy.startDateRequired') : undefined
            }
          />
        </div>

        {/* Strategy summary */}
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4">
          <div className="text-sm font-medium text-blue-700 dark:text-blue-300">
            {t('wizardStrategy.strategyPrefix', { strategy: state.strategy ? (STRATEGY_LABELS[state.strategy] ?? state.strategy) : t('wizardStrategy.strategyNotSelected') })}
          </div>
          <div className="text-sm text-blue-600 dark:text-blue-400 mt-1">
            {state.strategy && t(`wizardStrategy.strategyDescriptions.${state.strategy}`)}
          </div>
        </div>
      </div>

      {/* Income Linking */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 space-y-4">
        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">
          {t('wizardStrategy.sections.income')}
        </h4>

        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={state.incomeLinked}
            onChange={(e) => handleIncomeLinkToggle(e.target.checked)}
            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-500 dark:bg-gray-700"
          />
          <div>
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {t('wizardStrategy.linkBudgetToIncome')}
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400">
              {t('wizardStrategy.linkBudgetToIncomeHint')}
            </div>
          </div>
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <CurrencyInput
            label={t('wizardStrategy.baseMonthlyIncome')}
            prefix={getCurrencySymbol(state.currencyCode)}
            value={state.baseIncome ?? undefined}
            onChange={(val) => updateState({ baseIncome: val ?? null })}
            allowNegative={false}
          />
          {state.analysisResult && state.analysisResult.estimatedMonthlyIncome > 0 && (
            <div className="flex items-end pb-2">
              <span className="text-sm text-gray-500 dark:text-gray-400">
                {t('wizardStrategy.estimatedFromAnalysis', { amount: formatCurrency(state.analysisResult.estimatedMonthlyIncome, state.currencyCode) })}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Rollover Rules */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 space-y-4">
        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide flex items-center">
          {t('wizardStrategy.sections.rolloverRules')}
          <InfoTooltip text={t('wizardStrategy.rolloverTooltip')} learnMore="budgetRollover" />
        </h4>

        <Select
          label={t('wizardStrategy.defaultRolloverType')}
          value={state.defaultRolloverType}
          onChange={(e) => handleRolloverChange(e.target.value)}
          options={ROLLOVER_VALUES.map((v) => ({ value: v, label: t(`wizardStrategy.rolloverOptions.${v}`) }))}
        />

        <p className="text-xs text-gray-500 dark:text-gray-400">
          {t('wizardStrategy.rolloverHint')}
        </p>
      </div>

      {/* Alert Thresholds */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 space-y-4">
        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">
          {t('wizardStrategy.sections.alertThresholds')}
        </h4>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <NumericInput
              label={t('wizardStrategy.warningAt')}
              decimalPlaces={0}
              max={100}
              suffix="%"
              value={state.alertWarnPercent}
              onChange={(value) => {
                // The threshold is a percentage of the budget, so anything
                // outside 1-100 is discarded rather than clamped -- `max` only
                // trims on blur, and there is no floor that could be clamped to
                // without swallowing the leading digit of a two-digit entry.
                if (value !== undefined && value >= 1 && value <= 100) {
                  handleAlertDefaults('alertWarnPercent', value);
                }
              }}
            />
            <p className="mt-1 text-xs text-yellow-600 dark:text-yellow-400">
              {t('wizardStrategy.warningHint')}
            </p>
          </div>

          <div>
            <NumericInput
              label={t('wizardStrategy.criticalAt')}
              decimalPlaces={0}
              max={100}
              suffix="%"
              value={state.alertCriticalPercent}
              onChange={(value) => {
                // The threshold is a percentage of the budget, so anything
                // outside 1-100 is discarded rather than clamped -- `max` only
                // trims on blur, and there is no floor that could be clamped to
                // without swallowing the leading digit of a two-digit entry.
                if (value !== undefined && value >= 1 && value <= 100) {
                  handleAlertDefaults('alertCriticalPercent', value);
                }
              }}
            />
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">
              {t('wizardStrategy.criticalHint')}
            </p>
          </div>
        </div>
      </div>

      {/* Flex Groups */}
      {expenseCategories.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">
              {t('wizardStrategy.sections.flexGroups')}
            </h4>
            <button
              type="button"
              onClick={() => setShowFlexGroups(!showFlexGroups)}
              className="text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
            >
              {showFlexGroups ? t('wizardStrategy.flexGroupsHide') : t('wizardStrategy.flexGroupsConfigure')}
            </button>
          </div>

          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t('wizardStrategy.flexGroupsHint')}
          </p>

          {showFlexGroups && (
            <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-700/50 border-b border-gray-200 dark:border-gray-700">
                    <th className="text-left py-2 px-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      {t('wizardStrategy.flexGroupsTableHeaders.category')}
                    </th>
                    <th className="text-left py-2 px-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase w-48">
                      {t('wizardStrategy.flexGroupsTableHeaders.flexGroup')}
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {expenseCategories.map((cat) => (
                    <tr
                      key={cat.id}
                      className="border-b border-gray-100 dark:border-gray-700 last:border-0"
                    >
                      <td className="py-2 px-3 text-sm text-gray-900 dark:text-gray-100">
                        {cat.name}
                      </td>
                      <td className="py-2 px-3">
                        <input
                          type="text"
                          value={cat.flexGroup ?? ''}
                          onChange={(e) =>
                            handleFlexGroupChange(cat.id, e.target.value)
                          }
                          placeholder={t('wizardStrategy.flexGroupPlaceholder')}
                          maxLength={100}
                          className="w-full rounded border border-gray-300 px-2 py-1 text-sm focus:ring-1 focus:ring-blue-500 focus:outline-none dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100"
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Excluded Accounts */}
      {activeAccounts.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 space-y-4">
          <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide flex items-center">
            {t('wizardStrategy.sections.excludedAccounts')}
            <InfoTooltip text={t('wizardStrategy.excludedAccountsTooltip')} learnMore="budgetExcludedAccounts" />
          </h4>

          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t('wizardStrategy.excludedAccountsHint')}
          </p>

          <div className="max-h-48 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded-lg divide-y divide-gray-100 dark:divide-gray-700">
            {activeAccounts.map((account) => (
              <label
                key={account.id}
                className="flex items-center gap-3 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700 cursor-pointer"
              >
                <input
                  type="checkbox"
                  checked={state.excludedAccountIds.includes(account.id)}
                  onChange={(e) =>
                    handleExcludedAccountToggle(account.id, e.target.checked)
                  }
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-500 dark:bg-gray-700"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-gray-900 dark:text-gray-100 truncate">
                    {account.name}
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {account.accountType.replace(/_/g, ' ')}
                    {account.institution ? ` - ${account.institution}` : ''}
                  </div>
                </div>
              </label>
            ))}
          </div>

          {state.excludedAccountIds.length > 0 && (
            <div className="text-xs text-amber-600 dark:text-amber-400">
              {t('wizardStrategy.excludedCount', { count: state.excludedAccountIds.length })}
            </div>
          )}
        </div>
      )}

      {/* Category count */}
      <div className="text-sm text-gray-500 dark:text-gray-400 text-center">
        {t('wizardStrategy.categoriesAndTransfers', { categories: String(state.selectedCategories.size), transfers: String(state.selectedTransfers.size) })}
      </div>

      {/* Actions */}
      <div className="flex justify-between pt-4 border-t border-gray-200 dark:border-gray-700">
        <Button variant="outline" onClick={onBack}>
          {t('wizard.back')}
        </Button>
        <Button onClick={onNext} disabled={hasErrors}>
          {t('wizardStrategy.nextButton')}
        </Button>
      </div>
    </div>
  );
}
