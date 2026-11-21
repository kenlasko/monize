'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/Badge';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { Budget } from '@/types/budget';

interface BudgetListPebbleProps {
  budgets: readonly Budget[];
  onOpen: (budget: Budget) => void;
}

/**
 * The budgets as white blocks: a round initial, the name, what kind of budget
 * it is, and its state as a pill. Each block is one button that opens the
 * budget's dashboard. (An empty list is `EmptyState`, drawn by `BudgetList`.)
 */
export function BudgetListPebble({ budgets, onOpen }: BudgetListPebbleProps) {
  const t = useTranslations('budgets');
  const { formatDate } = useDateFormat();
  const { formatNumber } = useNumberFormat();
  return (
    <ul className="ui-bud-tiles grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
      {budgets.map((budget) => (
        <li key={budget.id}>
          <button
            type="button"
            className="ui-bud-tile block w-full text-left"
            onClick={() => onOpen(budget)}
          >
            <span className="flex items-center gap-3">
              <span
                aria-hidden="true"
                className="ui-bud-puck flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-gray-900 text-lg font-bold text-white dark:bg-blue-400 dark:text-gray-900"
              >
                {budget.name.trim().charAt(0).toUpperCase()}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate font-semibold text-gray-900 dark:text-gray-100">
                  {budget.name}
                </span>
                <span className="block truncate text-sm text-gray-500 dark:text-gray-400">
                  {t(`form.strategyOptions.${budget.strategy}`)} · {t(`form.typeOptions.${budget.budgetType}`)}
                </span>
              </span>
              <Badge variant={budget.isActive ? 'green' : 'gray'}>
                {budget.isActive ? t('pages.list.card.active') : t('pages.list.card.inactive')}
              </Badge>
            </span>
            <span className="mt-4 flex items-center justify-between text-sm text-gray-500 dark:text-gray-400">
              <span>{formatDate(budget.periodStart)}</span>
              <span>
                {t('pages.list.columns.categories')}: {formatNumber(budget.categories.length, 0)}
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
