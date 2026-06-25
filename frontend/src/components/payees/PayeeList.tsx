'use client';

import { useState, useMemo, useCallback, memo } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Payee } from '@/types/payee';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { payeesApi } from '@/lib/payees';
import toast from 'react-hot-toast';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { useTableDensity, nextDensity, type DensityLevel } from '@/hooks/useTableDensity';
import { HIGHLIGHT_FLASH, HIGHLIGHT_FLASH_CELL, useScrollIntoViewWhen } from '@/hooks/useHighlightTarget';
import { SortIcon } from '@/components/ui/SortIcon';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useLongPress, type LongPressRowHandlers } from '@/hooks/useLongPress';
import { RowActions } from '@/components/ui/row-actions/RowActions';
import { RowActionSheet } from '@/components/ui/row-actions/RowActionSheet';
import type { RowAction } from '@/components/ui/row-actions/rowAction';

const logger = createLogger('PayeeList');

type PayeeActionLabels = {
  edit: string;
  delete: string;
  merge: string;
  reactivate: string;
};

/**
 * Builds the standard row actions for a payee. Shared by the desktop `RowActions`
 * cell and the mobile `RowActionSheet` so both surfaces stay in sync.
 */
function buildPayeeActions(
  payee: Payee,
  labels: PayeeActionLabels,
  handlers: {
    onEdit: (payee: Payee) => void;
    onDelete: (payee: Payee) => void;
    onMerge?: (payee: Payee) => void;
    onReactivate?: (payeeId: string) => void;
  },
): RowAction[] {
  return [
    {
      key: 'reactivate',
      label: labels.reactivate,
      icon: 'reactivate',
      tone: 'success',
      onClick: () => handlers.onReactivate?.(payee.id),
      hidden: payee.isActive || !handlers.onReactivate,
    },
    {
      key: 'merge',
      label: labels.merge,
      icon: 'merge',
      tone: 'accent',
      onClick: () => handlers.onMerge?.(payee),
      hidden: !handlers.onMerge || !payee.isActive,
    },
    {
      key: 'edit',
      label: labels.edit,
      icon: 'edit',
      tone: 'primary',
      onClick: () => handlers.onEdit(payee),
    },
    {
      key: 'delete',
      label: labels.delete,
      icon: 'delete',
      tone: 'delete',
      destructive: true,
      onClick: () => handlers.onDelete(payee),
    },
  ];
}

// Re-export DensityLevel from shared hook
export type { DensityLevel };

export type SortField = 'name' | 'category' | 'count' | 'createdAt' | 'aliases' | 'lastUsed';
export type SortDirection = 'asc' | 'desc';

interface PayeeListProps {
  payees: Payee[];
  onEdit: (payee: Payee) => void;
  onRefresh: () => void;
  onDelete?: (payeeId: string) => void;
  onReactivate?: (payeeId: string) => void;
  onMerge?: (payee: Payee) => void;
  showStatusColumn?: boolean;
  density?: DensityLevel;
  onDensityChange?: (density: DensityLevel) => void;
  sortField?: SortField;
  sortDirection?: SortDirection;
  onSort?: (field: SortField) => void;
  categoryColorMap?: Map<string, string | null>;
  categoryLabelMap?: Map<string, string>;
  /** Payee id to flash/scroll to (e.g. arriving from a deep link). */
  highlightId?: string | null;
}

interface PayeeRowProps {
  payee: Payee;
  density: DensityLevel;
  cellPadding: string;
  onEdit: (payee: Payee) => void;
  onDelete: (payee: Payee) => void;
  onReactivate?: (payeeId: string) => void;
  onMerge?: (payee: Payee) => void;
  onViewTransactions: (payee: Payee) => void;
  showStatusColumn: boolean;
  index: number;
  categoryColorMap?: Map<string, string | null>;
  categoryLabelMap?: Map<string, string>;
  formatDate: (date: string) => string;
  getRowHandlers: (payee: Payee) => LongPressRowHandlers;
  isHighlighted?: boolean;
}

const PayeeRow = memo(function PayeeRow({
  payee,
  density,
  cellPadding,
  onEdit,
  onDelete,
  onReactivate,
  onMerge,
  onViewTransactions,
  showStatusColumn,
  index,
  categoryColorMap,
  categoryLabelMap,
  formatDate,
  getRowHandlers,
  isHighlighted,
}: PayeeRowProps) {
  const t = useTranslations('payees');
  const tc = useTranslations('common');
  const rowRef = useScrollIntoViewWhen<HTMLTableRowElement>(!!isHighlighted);
  const defaultCategoryColor = payee.defaultCategory
    ? (categoryColorMap?.get(payee.defaultCategory.id) ?? payee.defaultCategory.color)
    : null;
  const defaultCategoryLabel = payee.defaultCategory
    ? (categoryLabelMap?.get(payee.defaultCategory.id) ?? payee.defaultCategory.name)
    : null;
  const actions = useMemo(
    () => buildPayeeActions(
      payee,
      { edit: tc('actions.edit'), delete: tc('actions.delete'), merge: tc('actions.merge'), reactivate: tc('actions.reactivate') },
      { onEdit, onDelete, onMerge, onReactivate },
    ),
    [payee, tc, onEdit, onDelete, onMerge, onReactivate],
  );

  return (
    <tr
      ref={rowRef}
      className={`group hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer select-none ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-table-stripe-dark' : 'bg-white dark:bg-gray-900'} ${!payee.isActive ? 'opacity-60' : ''} ${isHighlighted ? HIGHLIGHT_FLASH : ''}`}
      {...getRowHandlers(payee)}
    >
      <td className={`${cellPadding} whitespace-nowrap`}>
        <div className="flex flex-col items-start gap-0.5 sm:flex-row sm:items-center sm:gap-2">
          <button
            onClick={(e) => { e.stopPropagation(); onViewTransactions(payee); }}
            className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline text-left"
            title={t('list.viewTransactionsTitle')}
          >
            {payee.name}
          </button>
          {(payee.uncategorizedCount ?? 0) > 0 && (
            <span
              className="inline-flex text-xs font-medium rounded-full px-2 py-0.5 bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
              title={t('list.uncategorizedTitle', { count: payee.uncategorizedCount ?? 0 })}
            >
              {t('list.uncategorizedBadge', { count: payee.uncategorizedCount ?? 0 })}
            </span>
          )}
        </div>
      </td>
      <td className={`${cellPadding} whitespace-nowrap hidden sm:table-cell`}>
        {payee.defaultCategory ? (
          <span
            className={`inline-flex text-xs leading-5 font-semibold rounded-full ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}
            style={{
              backgroundColor: defaultCategoryColor
                ? `color-mix(in srgb, ${defaultCategoryColor} 15%, var(--category-bg-base, #e5e7eb))`
                : 'var(--category-bg-base, #e5e7eb)',
              color: defaultCategoryColor
                ? `color-mix(in srgb, ${defaultCategoryColor} 85%, var(--category-text-mix, #000))`
                : 'var(--category-text-base, #6b7280)',
            }}
          >
            {defaultCategoryLabel}
          </span>
        ) : (
          <span className="text-sm text-gray-400 dark:text-gray-500">{t('list.noCategory')}</span>
        )}
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm text-gray-600 dark:text-gray-400 hidden md:table-cell`}>
        {payee.transactionCount ?? 0}
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-center text-sm text-gray-600 dark:text-gray-400 hidden lg:table-cell`}>
        {payee.aliasCount ?? 0}
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-500 dark:text-gray-400 hidden lg:table-cell`}>
        {payee.lastUsedDate ? formatDate(payee.lastUsedDate.substring(0, 10)) : '-'}
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-sm text-gray-500 dark:text-gray-400 hidden lg:table-cell`}>
        {payee.createdAt ? formatDate(payee.createdAt.substring(0, 10)) : '-'}
      </td>
      {showStatusColumn && (
        <td className={`${cellPadding} whitespace-nowrap hidden sm:table-cell`}>
          {payee.isActive ? (
            <span className="inline-flex text-xs font-medium rounded-full px-2 py-0.5 bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200">
              {t('list.statusBadge.active')}
            </span>
          ) : (
            <span className="inline-flex text-xs font-medium rounded-full px-2 py-0.5 bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400">
              {t('list.statusBadge.inactive')}
            </span>
          )}
        </td>
      )}
      {density === 'normal' && (
        <td className={`${cellPadding}`}>
          <div className="text-sm text-gray-500 dark:text-gray-400 max-w-xs truncate">
            {payee.notes || '-'}
          </div>
        </td>
      )}
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm font-medium hidden min-[480px]:table-cell sticky right-0 ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-table-stripe-dark' : 'bg-white dark:bg-gray-900'} group-hover:bg-gray-100 dark:group-hover:bg-gray-800 ${isHighlighted ? HIGHLIGHT_FLASH_CELL : ''}`}>
        <RowActions actions={actions} density={density} />
      </td>
    </tr>
  );
});

export function PayeeList({
  payees,
  onEdit,
  onRefresh,
  onDelete,
  onReactivate,
  onMerge,
  showStatusColumn = false,
  density: propDensity,
  onDensityChange,
  sortField: propSortField,
  sortDirection: propSortDirection,
  onSort,
  categoryColorMap,
  categoryLabelMap,
  highlightId,
}: PayeeListProps) {
  const t = useTranslations('payees');
  const tc = useTranslations('common');
  const router = useRouter();
  const { formatDate } = useDateFormat();
  const [deletePayee, setDeletePayee] = useState<Payee | null>(null);
  const [actionSheet, setActionSheet] = useState<{ open: boolean; payee: Payee | null }>({ open: false, payee: null });
  const [localDensity, setLocalDensity] = useState<DensityLevel>('normal');
  const [localSortField, setLocalSortField] = useState<SortField>('name');
  const [localSortDirection, setLocalSortDirection] = useState<SortDirection>('asc');

  // Use prop sort state if provided (controlled), otherwise use local state
  const sortField = propSortField ?? localSortField;
  const sortDirection = propSortDirection ?? localSortDirection;

  // Use prop density if provided, otherwise use local state
  const density = propDensity ?? localDensity;

  const { cellPadding, headerPadding } = useTableDensity(density);

  const cycleDensity = useCallback(() => {
    const next = nextDensity(density);
    if (onDensityChange) {
      onDensityChange(next);
    } else {
      setLocalDensity(next);
    }
  }, [density, onDensityChange]);

  const handleSort = useCallback((field: SortField) => {
    if (onSort) {
      onSort(field);
    } else {
      if (localSortField === field) {
        setLocalSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      } else {
        setLocalSortField(field);
        setLocalSortDirection(field === 'count' || field === 'aliases' || field === 'lastUsed' || field === 'createdAt' ? 'desc' : 'asc');
      }
    }
  }, [onSort, localSortField]);

  const displayPayees = useMemo(() => {
    if (onSort) {
      return payees;
    }
    return [...payees].sort((a, b) => {
      let comparison = 0;
      if (sortField === 'name') {
        comparison = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      } else if (sortField === 'category') {
        const catA = a.defaultCategory ? (categoryLabelMap?.get(a.defaultCategory.id) ?? a.defaultCategory.name) : '';
        const catB = b.defaultCategory ? (categoryLabelMap?.get(b.defaultCategory.id) ?? b.defaultCategory.name) : '';
        comparison = catA.localeCompare(catB, undefined, { sensitivity: 'base' });
      } else if (sortField === 'count') {
        comparison = (a.transactionCount ?? 0) - (b.transactionCount ?? 0);
      } else if (sortField === 'aliases') {
        comparison = (a.aliasCount ?? 0) - (b.aliasCount ?? 0);
      } else if (sortField === 'lastUsed') {
        comparison = (a.lastUsedDate || '').localeCompare(b.lastUsedDate || '');
      } else if (sortField === 'createdAt') {
        comparison = (a.createdAt || '').localeCompare(b.createdAt || '');
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [payees, sortField, sortDirection, onSort, categoryLabelMap]);

  const handleViewTransactions = useCallback((payee: Payee) => {
    router.push(`/transactions?payeeId=${payee.id}`);
  }, [router]);

  const { getRowHandlers } = useLongPress<Payee>({
    onLongPress: (payee) => setActionSheet({ open: true, payee }),
    onClick: onEdit,
  });

  const handleConfirmDelete = async () => {
    if (!deletePayee) return;

    try {
      await payeesApi.delete(deletePayee.id);
      toast.success(t('list.toasts.deleted'));
      if (onDelete) {
        onDelete(deletePayee.id);
      } else {
        onRefresh();
      }
    } catch (error) {
      toast.error(getErrorMessage(error, t('list.toasts.deleteFailed')));
      logger.error(error);
    } finally {
      setDeletePayee(null);
    }
  };

  if (payees.length === 0) {
    return (
      <div className="text-center py-12">
        <svg
          className="mx-auto h-12 w-12 text-gray-400 dark:text-gray-500"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z"
          />
        </svg>
        <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">{t('list.empty.title')}</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('list.empty.subtitle')}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="flex justify-end p-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
        <button
          onClick={cycleDensity}
          className="inline-flex items-center px-2 py-1 text-xs font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
          title={t('list.density.toggle')}
        >
          <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
          {density === 'normal' ? t('list.density.normal') : density === 'compact' ? t('list.density.compact') : t('list.density.dense')}
        </button>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-800">
            <tr>
              <th
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200`}
                onClick={() => handleSort('name')}
              >
                {t('list.columns.name')}<SortIcon field="name" sortField={sortField} sortDirection={sortDirection} />
              </th>
              <th
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 hidden sm:table-cell`}
                onClick={() => handleSort('category')}
              >
                {t('list.columns.defaultCategory')}<SortIcon field="category" sortField={sortField} sortDirection={sortDirection} />
              </th>
              <th
                className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 hidden md:table-cell`}
                onClick={() => handleSort('count')}
              >
                {t('list.columns.count')}<SortIcon field="count" sortField={sortField} sortDirection={sortDirection} />
              </th>
              <th
                className={`${headerPadding} text-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 hidden lg:table-cell`}
                onClick={() => handleSort('aliases')}
              >
                {t('list.columns.aliases')}<SortIcon field="aliases" sortField={sortField} sortDirection={sortDirection} />
              </th>
              <th
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 hidden lg:table-cell`}
                onClick={() => handleSort('lastUsed')}
              >
                {t('list.columns.lastUsed')}<SortIcon field="lastUsed" sortField={sortField} sortDirection={sortDirection} />
              </th>
              <th
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 hidden lg:table-cell`}
                onClick={() => handleSort('createdAt')}
              >
                {t('list.columns.created')}<SortIcon field="createdAt" sortField={sortField} sortDirection={sortDirection} />
              </th>
              {showStatusColumn && (
                <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell`}>
                  {t('list.columns.status')}
                </th>
              )}
              {density === 'normal' && (
                <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                  {t('list.columns.notes')}
                </th>
              )}
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden min-[480px]:table-cell sticky right-0 bg-gray-50 dark:bg-gray-800`}>
                {t('list.columns.actions')}
              </th>
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
            {displayPayees.map((payee, index) => (
              <PayeeRow
                key={payee.id}
                payee={payee}
                density={density}
                cellPadding={cellPadding}
                onEdit={onEdit}
                onDelete={setDeletePayee}
                onReactivate={onReactivate}
                onMerge={onMerge}
                onViewTransactions={handleViewTransactions}
                showStatusColumn={showStatusColumn}
                index={index}
                categoryColorMap={categoryColorMap}
                categoryLabelMap={categoryLabelMap}
                formatDate={formatDate}
                getRowHandlers={getRowHandlers}
                isHighlighted={!!highlightId && payee.id === highlightId}
              />
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        isOpen={deletePayee !== null}
        title={t('list.deleteConfirm.title', { name: deletePayee?.name ?? '' })}
        message={t('list.deleteConfirm.message')}
        confirmLabel={t('list.deleteConfirm.confirmLabel')}
        cancelLabel={t('list.deleteConfirm.cancelLabel')}
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeletePayee(null)}
      />

      <RowActionSheet
        isOpen={actionSheet.open}
        title={actionSheet.payee?.name ?? ''}
        actions={actionSheet.payee
          ? buildPayeeActions(
              actionSheet.payee,
              { edit: tc('actions.edit'), delete: tc('actions.delete'), merge: tc('actions.merge'), reactivate: tc('actions.reactivate') },
              { onEdit, onDelete: setDeletePayee, onMerge, onReactivate },
            )
          : []}
        onClose={() => setActionSheet({ open: false, payee: null })}
      />
    </div>
  );
}
