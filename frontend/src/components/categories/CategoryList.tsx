'use client';

import { useState, useMemo, useCallback, memo } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { Category } from '@/types/category';
import { DeleteCategoryDialog } from './DeleteCategoryDialog';
import { categoriesApi } from '@/lib/categories';
import toast from 'react-hot-toast';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { useTableDensity, nextDensity, type DensityLevel } from '@/hooks/useTableDensity';
import { SortIcon } from '@/components/ui/SortIcon';
import { useLongPress, type LongPressRowHandlers } from '@/hooks/useLongPress';
import { RowActions } from '@/components/ui/row-actions/RowActions';
import { RowActionSheet } from '@/components/ui/row-actions/RowActionSheet';
import type { RowAction } from '@/components/ui/row-actions/rowAction';

const logger = createLogger('CategoryList');

/**
 * Builds the standard row actions for a category. Shared by the desktop
 * `RowActions` cell and the mobile `RowActionSheet`.
 */
function buildCategoryActions(
  category: Category,
  labels: { edit: string; delete: string },
  handlers: { onEdit: (category: Category) => void; onDeleteClick: (category: Category) => void },
): RowAction[] {
  return [
    {
      key: 'edit',
      label: labels.edit,
      icon: 'edit',
      tone: 'primary',
      onClick: () => handlers.onEdit(category),
    },
    {
      key: 'delete',
      label: labels.delete,
      icon: 'delete',
      tone: 'delete',
      destructive: true,
      onClick: () => handlers.onDeleteClick(category),
      hidden: category.isSystem,
    },
  ];
}

export type { DensityLevel } from '@/hooks/useTableDensity';

export type SortField = 'name' | 'type' | 'count';
export type SortDirection = 'asc' | 'desc';

interface CategoryRowProps {
  category: Category & { _level?: number };
  density: DensityLevel;
  cellPadding: string;
  onEdit: (category: Category) => void;
  onDeleteClick: (category: Category) => void;
  onViewTransactions: (category: Category) => void;
  index: number;
  getRowHandlers: (category: Category) => LongPressRowHandlers;
}

const CategoryRow = memo(function CategoryRow({
  category,
  density,
  cellPadding,
  onEdit,
  onDeleteClick,
  onViewTransactions,
  index,
  getRowHandlers,
}: CategoryRowProps) {
  const t = useTranslations('categories');
  const tc = useTranslations('common');

  const actions = useMemo(
    () => buildCategoryActions(
      category,
      { edit: tc('actions.edit'), delete: tc('actions.delete') },
      { onEdit, onDeleteClick },
    ),
    [category, tc, onEdit, onDeleteClick],
  );

  return (
    <tr
      className={`group hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer select-none ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-table-stripe-dark' : 'bg-white dark:bg-gray-900'}`}
      {...getRowHandlers(category)}
    >
      <td className={`${cellPadding} whitespace-nowrap`}>
        <div
          className="flex items-center"
          style={{ paddingLeft: `${(category._level || 0) * (density === 'dense' ? 0.75 : 1.5)}rem` }}
        >
          {category.effectiveColor && (
            <span
              className={`rounded-full mr-2 flex-shrink-0 ${density === 'dense' ? 'w-2 h-2' : 'w-3 h-3'} ${
                !category.color && category.effectiveColor ? 'opacity-50' : ''
              }`}
              style={{ backgroundColor: category.effectiveColor }}
              title={!category.color && category.effectiveColor ? t('list.inheritedColorTitle') : undefined}
            />
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onViewTransactions(category); }}
            className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline text-left"
            title={t('list.viewTransactionsTitle')}
          >
            {category.name}
          </button>
          {category.isSystem && density !== 'dense' && (
            <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">{t('list.systemBadge')}</span>
          )}
        </div>
      </td>
      <td className={`${cellPadding} whitespace-nowrap hidden sm:table-cell`}>
        <span
          className={`inline-flex text-xs leading-5 font-semibold rounded-full ${
            category.isIncome
              ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
              : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
          } ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}
        >
          {category.isIncome ? t('list.badgeIncome') : t('list.badgeExpense')}
        </span>
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm text-gray-600 dark:text-gray-400 hidden md:table-cell`}>
        {category.transactionCount ?? 0}
      </td>
      {density === 'normal' && (
        <td className={`${cellPadding}`}>
          <div className="text-sm text-gray-500 dark:text-gray-400 max-w-xs truncate">
            {category.description || '-'}
          </div>
        </td>
      )}
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm font-medium hidden min-[480px]:table-cell sticky right-0 ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-table-stripe-dark' : 'bg-white dark:bg-gray-900'} group-hover:bg-gray-100 dark:group-hover:bg-gray-800`}>
        <RowActions actions={actions} density={density} />
      </td>
    </tr>
  );
});

interface CategoryListProps {
  categories: Category[];
  onEdit: (category: Category) => void;
  onRefresh: () => void;
  onDelete?: (categoryId: string) => void;
  density?: DensityLevel;
  onDensityChange?: (density: DensityLevel) => void;
  sortField?: SortField;
  sortDirection?: SortDirection;
  onSort?: (field: SortField) => void;
}

export function CategoryList({
  categories,
  onEdit,
  onRefresh,
  onDelete,
  density: propDensity,
  onDensityChange,
  sortField: propSortField,
  sortDirection: propSortDirection,
  onSort,
}: CategoryListProps) {
  const t = useTranslations('categories');
  const tc = useTranslations('common');
  const router = useRouter();
  const [deleteCategory, setDeleteCategory] = useState<Category | null>(null);
  const [actionSheet, setActionSheet] = useState<{ open: boolean; category: Category | null }>({ open: false, category: null });
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
        setLocalSortDirection(field === 'count' ? 'desc' : 'asc');
      }
    }
  }, [onSort, localSortField]);

  const handleViewTransactions = useCallback((category: Category) => {
    router.push(`/transactions?categoryId=${category.id}`);
  }, [router]);

  const handleDeleteClick = useCallback((category: Category) => {
    if (category.isSystem) {
      toast.error(t('toasts.cannotDeleteSystem'));
      return;
    }
    setDeleteCategory(category);
  }, [t]);

  const { getRowHandlers } = useLongPress<Category>({
    onLongPress: (category) => setActionSheet({ open: true, category }),
    onClick: onEdit,
  });

  const handleConfirmDelete = async (reassignToCategoryId: string | null) => {
    if (!deleteCategory) return;

    try {
      // Check if there are transactions to reassign
      const count = await categoriesApi.getTransactionCount(deleteCategory.id);
      if (count > 0) {
        await categoriesApi.reassignTransactions(deleteCategory.id, reassignToCategoryId);
      }

      await categoriesApi.delete(deleteCategory.id);
      toast.success(t('toasts.deleted'));
      if (onDelete) {
        onDelete(deleteCategory.id);
      } else {
        onRefresh();
      }
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.deleteFailed')));
      logger.error(error);
    } finally {
      setDeleteCategory(null);
    }
  };

  // Sorting function for categories
  const sortCategories = useCallback((cats: Category[]) => {
    return [...cats].sort((a, b) => {
      let comparison = 0;
      if (sortField === 'name') {
        comparison = a.name.localeCompare(b.name);
      } else if (sortField === 'type') {
        // Income comes before Expense when ascending
        comparison = (a.isIncome === b.isIncome) ? 0 : (a.isIncome ? -1 : 1);
      } else if (sortField === 'count') {
        comparison = (a.transactionCount ?? 0) - (b.transactionCount ?? 0);
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [sortField, sortDirection]);

  // Build tree structure with sorting
  const treeCategories = useMemo(() => {
    const buildTree = (parentId: string | null = null, level: number = 0): (Category & { _level: number })[] => {
      const children = categories.filter((c) => c.parentId === parentId);
      const sorted = sortCategories(children);
      return sorted.flatMap((category) => [
        { ...category, _level: level },
        ...buildTree(category.id, level + 1),
      ]);
    };
    return buildTree();
  }, [categories, sortCategories]);

  if (categories.length === 0) {
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
            d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
          />
        </svg>
        <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">{t('list.emptyHeading')}</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('list.emptyDescription')}</p>
      </div>
    );
  }

  return (
    <div>
      {/* Density toggle */}
      <div className="flex justify-end p-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
        <button
          onClick={cycleDensity}
          className="inline-flex items-center px-2 py-1 text-xs font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
          title={t('list.densityToggleTitle')}
        >
          <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
          {density === 'normal' ? t('list.densityNormal') : density === 'compact' ? t('list.densityCompact') : t('list.densityDense')}
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
                {t('list.colName')}<SortIcon field="name" sortField={sortField} sortDirection={sortDirection} />
              </th>
              <th
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 hidden sm:table-cell`}
                onClick={() => handleSort('type')}
              >
                {t('list.colType')}<SortIcon field="type" sortField={sortField} sortDirection={sortDirection} />
              </th>
              <th
                className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 hidden md:table-cell`}
                onClick={() => handleSort('count')}
              >
                {t('list.colCount')}<SortIcon field="count" sortField={sortField} sortDirection={sortDirection} />
              </th>
              {density === 'normal' && (
                <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                  {t('list.colDescription')}
                </th>
              )}
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden min-[480px]:table-cell sticky right-0 bg-gray-50 dark:bg-gray-800`}>
                {t('list.colActions')}
              </th>
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
            {treeCategories.map((category: Category & { _level?: number }, index) => (
              <CategoryRow
                key={category.id}
                category={category}
                density={density}
                cellPadding={cellPadding}
                onEdit={onEdit}
                onDeleteClick={handleDeleteClick}
                onViewTransactions={handleViewTransactions}
                index={index}
                getRowHandlers={getRowHandlers}
              />
            ))}
          </tbody>
        </table>
      </div>

      <DeleteCategoryDialog
        isOpen={deleteCategory !== null}
        category={deleteCategory}
        categories={categories}
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeleteCategory(null)}
      />

      <RowActionSheet
        isOpen={actionSheet.open}
        title={actionSheet.category?.name ?? ''}
        actions={actionSheet.category
          ? buildCategoryActions(
              actionSheet.category,
              { edit: tc('actions.edit'), delete: tc('actions.delete') },
              { onEdit, onDeleteClick: handleDeleteClick },
            )
          : []}
        onClose={() => setActionSheet({ open: false, category: null })}
      />
    </div>
  );
}
