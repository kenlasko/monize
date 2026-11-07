'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { ChartPieIcon } from '@heroicons/react/24/outline';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { INTERACTIVE_ROW_FOCUS_CLASS, activateOnKey } from '@/components/ui/interactive-row';
import { TABLE_BODY_CLASS, TABLE_CLASS, TD_CLASS, Th } from '@/components/ui/Table';
import { useLongPress } from '@/hooks/useLongPress';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import type { Budget } from '@/types/budget';

interface BudgetListProps {
  budgets: readonly Budget[];
  /** Opens one budget's dashboard. */
  onOpen: (budget: Budget) => void;
  /** Starts the create wizard; the empty list's call to action. */
  onCreate: () => void;
}

/**
 * The budgets as a table the reader scans and compares, one row per budget,
 * the whole row opening its dashboard (`useLongPress({ onClick })`, reachable
 * from the keyboard through `activateOnKey`). A budget has no row actions of
 * its own -- edit and delete live on its detail page -- so a long press opens
 * it too rather than an empty action sheet.
 *
 * An empty list renders `EmptyState` from here, with the wizard as its action.
 */
export function BudgetList({ budgets, onOpen, onCreate }: BudgetListProps) {
  const t = useTranslations('budgets');
  const { formatDate } = useDateFormat();
  const { formatNumber } = useNumberFormat();

  const open = useCallback((budget: Budget) => onOpen(budget), [onOpen]);
  const { getRowHandlers } = useLongPress<Budget>({ onLongPress: open, onClick: open });

  if (budgets.length === 0) {
    return (
      <EmptyState
        icon={<ChartPieIcon />}
        title={t('pages.list.empty.title')}
        description={t('pages.list.empty.description')}
        action={<Button onClick={onCreate}>{t('pages.list.empty.cta')}</Button>}
        help="budgets"
      />
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className={TABLE_CLASS}>
        <thead className="bg-gray-50 dark:bg-gray-800">
          <tr>
            <Th>{t('pages.list.columns.name')}</Th>
            <Th className="hidden sm:table-cell">{t('pages.list.columns.strategy')}</Th>
            <Th className="hidden md:table-cell">{t('pages.list.columns.type')}</Th>
            <Th align="right">{t('pages.list.columns.categories')}</Th>
            <Th className="hidden sm:table-cell">{t('pages.list.columns.started')}</Th>
            <Th>{t('pages.list.columns.status')}</Th>
          </tr>
        </thead>
        <tbody className={`bg-white dark:bg-gray-900 ${TABLE_BODY_CLASS}`}>
          {budgets.map((budget) => (
            <tr
              key={budget.id}
              tabIndex={0}
              className={`cursor-pointer select-none ${INTERACTIVE_ROW_FOCUS_CLASS} ${HOVER_ROW_ON_CARD}`}
              {...getRowHandlers(budget)}
              onKeyDown={activateOnKey(() => open(budget))}
            >
              <td className={`${TD_CLASS} font-medium break-words`}>{budget.name}</td>
              <td className={`${TD_CLASS} hidden whitespace-nowrap sm:table-cell`}>
                {t(`form.strategyOptions.${budget.strategy}`)}
              </td>
              <td className={`${TD_CLASS} hidden whitespace-nowrap md:table-cell`}>
                {t(`form.typeOptions.${budget.budgetType}`)}
              </td>
              <td className={`${TD_CLASS} whitespace-nowrap text-right`}>
                {formatNumber(budget.categories.length, 0)}
              </td>
              <td className={`${TD_CLASS} hidden whitespace-nowrap sm:table-cell`}>
                {formatDate(budget.periodStart)}
              </td>
              <td className={`${TD_CLASS} whitespace-nowrap`}>
                <Badge variant={budget.isActive ? 'green' : 'gray'}>
                  {budget.isActive ? t('pages.list.card.active') : t('pages.list.card.inactive')}
                </Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
