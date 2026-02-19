'use client';

import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { STRATEGY_LABELS } from './utils/budget-labels';
import type { WizardState } from './BudgetWizard';

interface BudgetWizardStrategyProps {
  state: WizardState;
  updateState: (updates: Partial<WizardState>) => void;
  onNext: () => void;
  onBack: () => void;
}

const BUDGET_TYPE_OPTIONS = [
  { value: 'MONTHLY', label: 'Monthly' },
  { value: 'ANNUAL', label: 'Annual' },
  { value: 'PAY_PERIOD', label: 'Pay Period' },
];

export function BudgetWizardStrategy({
  state,
  updateState,
  onNext,
  onBack,
}: BudgetWizardStrategyProps) {
  const hasErrors = !state.budgetName.trim() || !state.periodStart;

  return (
    <div className="space-y-6">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
        Configure Your Budget
      </h3>

      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 space-y-4">
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
        <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-4 mt-4">
          <div className="text-sm font-medium text-blue-700 dark:text-blue-300">
            Strategy: {STRATEGY_LABELS[state.strategy] ?? state.strategy}
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

        {/* Selected categories count */}
        <div className="text-sm text-gray-500 dark:text-gray-400">
          {state.selectedCategories.size} categories selected
        </div>
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
