'use client';

import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { Select } from '@/components/ui/Select';
import { STRATEGY_LABELS } from './utils/budget-labels';
import { getCurrencySymbol } from '@/lib/format';
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

const BUDGET_TYPE_OPTIONS = [
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'ANNUAL', label: 'Annual' },
  { value: 'PAY_PERIOD', label: 'Pay Period' },
];

const ROLLOVER_OPTIONS = [
  { value: 'NONE', label: 'None -- Resets each period' },
  { value: 'MONTHLY', label: 'Monthly -- Rolls forward every month' },
  { value: 'QUARTERLY', label: 'Quarterly -- Rolls forward every quarter' },
  { value: 'ANNUAL', label: 'Annual -- Rolls forward every year' },
];

export function BudgetWizardStrategy({
  state,
  updateState,
  accounts = [],
  onNext,
  onBack,
}: BudgetWizardStrategyProps) {
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
        Configure Your Budget
      </h3>

      {/* Budget Details */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 space-y-4">
        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">
          Budget Details
        </h4>

        <Input
          label="Budget Name"
          value={state.budgetName}
          onChange={(e) => updateState({ budgetName: e.target.value })}
          maxLength={255}
          error={
            !state.budgetName.trim()
              ? 'Budget name is required'
              : undefined
          }
        />

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <Select
            label="Budget Type"
            value={state.budgetType}
            onChange={(e) =>
              updateState({
                budgetType: e.target.value as WizardState['budgetType'],
              })
            }
            options={BUDGET_TYPE_OPTIONS}
          />

          <Input
            label="Start Date"
            type="date"
            value={state.periodStart}
            onChange={(e) => updateState({ periodStart: e.target.value })}
            error={
              !state.periodStart ? 'Start date is required' : undefined
            }
          />
        </div>

        {/* Strategy summary */}
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4">
          <div className="text-sm font-medium text-blue-700 dark:text-blue-300">
            Strategy: {state.strategy ? (STRATEGY_LABELS[state.strategy] ?? state.strategy) : 'Not selected'}
          </div>
          <div className="text-sm text-blue-600 dark:text-blue-400 mt-1">
            {state.strategy === 'FIXED' &&
              'Set amounts per category. Unspent budget resets each period.'}
            {state.strategy === 'ROLLOVER' &&
              'Unspent budget carries forward based on per-category rollover rules.'}
            {state.strategy === 'ZERO_BASED' &&
              'Every dollar of income is assigned. Income minus expenses should equal zero.'}
            {state.strategy === 'FIFTY_THIRTY_TWENTY' &&
              'Categories grouped as Needs (50%), Wants (30%), Savings (20%).'}
          </div>
        </div>
      </div>

      {/* Income Linking */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 space-y-4">
        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">
          Income
        </h4>

        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={state.incomeLinked}
            onChange={(e) => updateState({ incomeLinked: e.target.checked })}
            className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 dark:border-gray-500 dark:bg-gray-700"
          />
          <div>
            <div className="text-sm font-medium text-gray-900 dark:text-gray-100">
              Link budget to income
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400">
              Category amounts become percentages of your base income
            </div>
          </div>
        </label>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <CurrencyInput
            label="Base Monthly Income"
            prefix={getCurrencySymbol(state.currencyCode)}
            value={state.baseIncome ?? undefined}
            onChange={(val) => updateState({ baseIncome: val ?? null })}
            allowNegative={false}
          />
          {state.analysisResult && state.analysisResult.estimatedMonthlyIncome > 0 && (
            <div className="flex items-end pb-2">
              <span className="text-sm text-gray-500 dark:text-gray-400">
                Estimated from analysis:{' '}
                <span className="font-medium text-gray-700 dark:text-gray-300">
                  {getCurrencySymbol(state.currencyCode)}{state.analysisResult.estimatedMonthlyIncome.toFixed(2)}/mo
                </span>
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Rollover Rules */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 space-y-4">
        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">
          Rollover Rules
        </h4>

        <Select
          label="Default Rollover Type"
          value={state.defaultRolloverType}
          onChange={(e) => handleRolloverChange(e.target.value)}
          options={ROLLOVER_OPTIONS}
        />

        <p className="text-xs text-gray-500 dark:text-gray-400">
          This sets the default for all categories. You can customize individual categories after creating the budget.
        </p>
      </div>

      {/* Alert Thresholds */}
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 space-y-4">
        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">
          Alert Thresholds
        </h4>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Warning at (%)
            </label>
            <input
              type="number"
              min={1}
              max={100}
              value={state.alertWarnPercent}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val) && val >= 1 && val <= 100) {
                  handleAlertDefaults('alertWarnPercent', val);
                }
              }}
              className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 text-sm"
            />
            <p className="mt-1 text-xs text-yellow-600 dark:text-yellow-400">
              Triggers a warning when spending reaches this % of budget
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Critical at (%)
            </label>
            <input
              type="number"
              min={1}
              max={100}
              value={state.alertCriticalPercent}
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                if (!isNaN(val) && val >= 1 && val <= 100) {
                  handleAlertDefaults('alertCriticalPercent', val);
                }
              }}
              className="block w-full rounded-md border-gray-300 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:text-gray-100 text-sm"
            />
            <p className="mt-1 text-xs text-red-600 dark:text-red-400">
              Triggers a critical alert when spending reaches this % of budget
            </p>
          </div>
        </div>
      </div>

      {/* Flex Groups */}
      {expenseCategories.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">
              Flex Groups
            </h4>
            <button
              type="button"
              onClick={() => setShowFlexGroups(!showFlexGroups)}
              className="text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
            >
              {showFlexGroups ? 'Hide' : 'Configure'}
            </button>
          </div>

          <p className="text-xs text-gray-500 dark:text-gray-400">
            Group related expense categories together. Spending is tracked as a group total, giving flexibility within each group.
          </p>

          {showFlexGroups && (
            <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
              <table className="w-full">
                <thead>
                  <tr className="bg-gray-50 dark:bg-gray-750 border-b border-gray-200 dark:border-gray-700">
                    <th className="text-left py-2 px-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase">
                      Category
                    </th>
                    <th className="text-left py-2 px-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase w-48">
                      Flex Group
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
                          placeholder="e.g. Fun Money"
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
          <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 uppercase tracking-wide">
            Excluded Accounts
          </h4>

          <p className="text-xs text-gray-500 dark:text-gray-400">
            Transactions from excluded accounts will not count toward your budget totals.
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
              {state.excludedAccountIds.length} account{state.excludedAccountIds.length === 1 ? '' : 's'} excluded
            </div>
          )}
        </div>
      )}

      {/* Category count */}
      <div className="text-sm text-gray-500 dark:text-gray-400 text-center">
        {state.selectedCategories.size} categories and{' '}
        {state.selectedTransfers.size} transfers selected
      </div>

      {/* Actions */}
      <div className="flex justify-between pt-4 border-t border-gray-200 dark:border-gray-700">
        <Button variant="outline" onClick={onBack}>
          Back
        </Button>
        <Button onClick={onNext} disabled={hasErrors}>
          Next: Review
        </Button>
      </div>
    </div>
  );
}
