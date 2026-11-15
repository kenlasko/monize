'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { SortableHeader } from '@/components/ui/SortableHeader';
import {
  DEFAULT_WIZARD_SORT,
  nextWizardSort,
  sortWizardRows,
  type WizardSortAccessors,
  type WizardSortField,
  type WizardTableSort,
} from './utils/wizard-table-sort';

export type WizardTableTone = 'income' | 'expense' | 'transfer';

const TONE_CLASSES: Record<WizardTableTone, { row: string; cell: string }> = {
  income: {
    row: 'bg-green-50 dark:bg-green-900/20 border-b border-green-200 dark:border-green-800',
    cell: 'text-green-700 dark:text-green-400',
  },
  expense: {
    row: 'bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800',
    cell: 'text-red-700 dark:text-red-400',
  },
  transfer: {
    row: 'bg-blue-50 dark:bg-blue-900/20 border-b border-blue-200 dark:border-blue-800',
    cell: 'text-blue-700 dark:text-blue-400',
  },
};

export interface WizardTableSortState<T> {
  rows: readonly T[];
  sort: WizardTableSort;
  onSort: (field: WizardSortField) => void;
}

/** One wizard table's rows in its sort, starting from the order the table opens in. */
export function useWizardTableSort<T>(
  rows: readonly T[],
  accessors: WizardSortAccessors<T>,
): WizardTableSortState<T> {
  const [sort, setSort] = useState<WizardTableSort>(DEFAULT_WIZARD_SORT);
  return {
    rows: sortWizardRows(rows, sort, accessors),
    sort,
    onSort: (field) => setSort((prev) => nextWizardSort(prev, field)),
  };
}

/** The name, trend/median and amount headers of a wizard table, each sortable. */
export function BudgetWizardTableHead({
  tone,
  nameLabel,
  table: { sort, onSort },
}: {
  tone: WizardTableTone;
  nameLabel: string;
  table: Pick<WizardTableSortState<unknown>, 'sort' | 'onSort'>;
}) {
  const t = useTranslations('budgets');
  const { row, cell } = TONE_CLASSES[tone];
  // The headers' field type includes `default`, the order no header names.
  const shared = {
    sortField: sort.field,
    sortDirection: sort.direction,
    onSort: (field: WizardTableSort['field']) => {
      if (field !== 'default') onSort(field);
    },
  };
  return (
    <thead>
      <tr className={row}>
        <SortableHeader<WizardTableSort['field']>
          field="name"
          {...shared}
          className={`text-left py-2 pl-1 pr-0 sm:px-4 text-xs font-medium uppercase ${cell}`}
        >
          {nameLabel}
        </SortableHeader>
        <SortableHeader<WizardTableSort['field']>
          field="median"
          align="right"
          {...shared}
          className={`hidden sm:table-cell w-44 text-right py-2 px-4 text-xs font-medium uppercase ${cell}`}
        >
          {t('wizardCategories.tableHeaders.trendMedian')}
        </SortableHeader>
        <SortableHeader<WizardTableSort['field']>
          field="amount"
          align="right"
          {...shared}
          className={`w-24 sm:w-48 py-2 pl-0.5 pr-1 sm:px-4 text-xs font-medium uppercase text-right ${cell}`}
        >
          {t('wizardCategories.tableHeaders.amount')}
        </SortableHeader>
      </tr>
    </thead>
  );
}
