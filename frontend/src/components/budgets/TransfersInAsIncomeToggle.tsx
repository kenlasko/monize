'use client';

import { useId } from 'react';
import { useTranslations } from 'next-intl';

interface TransfersInAsIncomeToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  /** How many accounts the budget excludes; the option counts nothing without one. */
  excludedCount: number;
}

/**
 * The budget-wide "transfers in count as income" option (issue #2141): money
 * moved in from the accounts a budget excludes counts as its income. Shared by
 * the budget wizard and the budget settings form.
 */
export function TransfersInAsIncomeToggle({
  checked,
  onChange,
  excludedCount,
}: TransfersInAsIncomeToggleProps) {
  const t = useTranslations('budgets');
  const id = useId();

  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-labelledby={`${id}-label`}
        aria-describedby={`${id}-hint`}
        className="mt-0.5 rounded border-gray-300 text-blue-600 focus-visible:ring-blue-500 dark:border-gray-500 dark:bg-gray-700"
      />
      <div>
        <div id={`${id}-label`} className="text-sm font-medium text-gray-900 dark:text-gray-100">
          {t('transfersInAsIncome.label')}
        </div>
        <div id={`${id}-hint`} className="text-xs text-gray-500 dark:text-gray-400">
          {t('transfersInAsIncome.hint')}
        </div>
        {checked && excludedCount === 0 && (
          <div className="text-xs text-amber-600 dark:text-amber-400">
            {t('transfersInAsIncome.noExcludedAccounts')}
          </div>
        )}
      </div>
    </label>
  );
}
