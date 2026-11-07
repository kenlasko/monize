'use client';

import { useState, useMemo, useCallback, memo } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { TagIcon } from '@heroicons/react/24/outline';
import { Category } from '@/types/category';
import { CategoryGlyph } from '@/components/categories/CategoryGlyph';
import { DeleteCategoryDialog } from './DeleteCategoryDialog';
import { categoriesApi } from '@/lib/categories';
import toast from 'react-hot-toast';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { useTableDensity, type DensityLevel } from '@/hooks/useTableDensity';
import { useDensityPreference } from '@/store/densityStore';
import { HIGHLIGHT_FLASH, HIGHLIGHT_FLASH_CELL, useScrollIntoViewWhen } from '@/hooks/useHighlightTarget';
import { SortIcon } from '@/components/ui/SortIcon';
import { useLongPress, type LongPressRowHandlers } from '@/hooks/useLongPress';
import { RowActions } from '@/components/ui/row-actions/RowActions';
import { RowActionSheet } from '@/components/ui/row-actions/RowActionSheet';
import type { RowAction } from '@/components/ui/row-actions/rowAction';
import { DensityToggleBar } from '@/components/ui/DensityToggle';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';
import { useIsMobile } from '@/hooks/useIsMobile';
import { CellLabel, SortableTh, Th } from '@/components/ui/Table';

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

/**
 * Every field this list sorts by, in the tier header's order. The phone's slim
 * control header renders all of them: the chosen field is persisted
 * (`monize-categories-sort-field`, on the Categories page) and Type and Count
 * are hidden at phone width in the tier table, so a header offering fewer
 * would strand a phone on a sort order it can neither see nor undo. A `Record`
 * keyed by the union, so a fourth sort field is a type error until it is given
 * a position here.
 *
 * Sorting orders SIBLINGS: the list is a parent/child tree, so each level is
 * sorted within its parent and a subcategory never leaves the parent it
 * belongs to.
 */
const SORT_FIELD_ORDER: Record<SortField, number> = {
  name: 0,
  type: 1,
  count: 2,
};

const SORT_FIELDS: readonly SortField[] = (
  Object.keys(SORT_FIELD_ORDER) as SortField[]
).sort((a, b) => SORT_FIELD_ORDER[a] - SORT_FIELD_ORDER[b]);

/** The Income/Expense pill, in both layouts. */
function CategoryTypePill({ category, density }: { category: Category; density: DensityLevel }) {
  const t = useTranslations('categories');
  return (
    <span
      className={`inline-flex text-xs leading-5 font-semibold rounded-full ${
        category.isIncome
          ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
          : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
      } ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}
    >
      {category.isIncome ? t('list.badgeIncome') : t('list.badgeExpense')}
    </span>
  );
}

interface CategoryRowProps {
  category: Category & { _level?: number };
  density: DensityLevel;
  cellPadding: string;
  onEdit: (category: Category) => void;
  onDeleteClick: (category: Category) => void;
  onViewTransactions: (category: Category) => void;
  index: number;
  getRowHandlers: (category: Category) => LongPressRowHandlers;
  isHighlighted?: boolean;
  /**
   * Render the row as a wrapped card instead of the tier table's cells. The
   * list sets it for phones at Normal density only (on a phone the density
   * toggle picks the layout); every other width and density renders the tier
   * row, unchanged. The card carries every value the tier row shows (name,
   * system marker, type, count, description), indented by its tree level;
   * only the Actions column is left out, because Edit and Delete are what the
   * long-press (and right-click) sheet these same row handlers open carries.
   */
  wrapped?: boolean;
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
  isHighlighted,
  wrapped = false,
}: CategoryRowProps) {
  const t = useTranslations('categories');
  const tc = useTranslations('common');
  const rowRef = useScrollIntoViewWhen<HTMLTableRowElement>(!!isHighlighted);

  const actions = useMemo(
    () => buildCategoryActions(
      category,
      { edit: tc('actions.edit'), delete: tc('actions.delete') },
      { onEdit, onDeleteClick },
    ),
    [category, tc, onEdit, onDeleteClick],
  );

  // Dense rows drop to the bare colour dot: an icon at that row height is
  // noise rather than a cue.
  const glyphIcon =
    density === 'dense' ? null : (category.effectiveIcon ?? category.icon);

  const nameCell = (
    <>
      <CategoryGlyph
        icon={glyphIcon}
        color={category.effectiveColor}
        inherited={!category.color && !category.icon}
        size={glyphIcon ? 16 : density === 'dense' ? 8 : 12}
        title={
          !category.color && category.effectiveColor
            ? t('list.inheritedColorTitle')
            : undefined
        }
        className="mr-2"
      />
      <button
        onClick={(e) => { e.stopPropagation(); onViewTransactions(category); }}
        className={`text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline text-left${wrapped ? ' min-w-0 break-words' : ''}`}
        title={t('list.viewTransactionsTitle')}
      >
        {category.name}
      </button>
      {category.isSystem && density !== 'dense' && (
        <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">{t('list.systemBadge')}</span>
      )}
    </>
  );

  // Phone + Normal density: one wrapped card per row instead of the tier
  // table's cells (see the `wrapped` prop). The glyph, name, pill and count
  // are the same nodes the tier branch renders, so the two layouts cannot
  // disagree about a category.
  if (wrapped) {
    return (
      <tr
        ref={rowRef}
        className={`hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer select-none bg-white dark:bg-gray-900 ${isHighlighted ? HIGHLIGHT_FLASH : ''}`}
        {...getRowHandlers(category)}
      >
        <td className="p-0">
          <div className={cellPadding}>
            {/* The tree level indents the whole card, so a subcategory still
                reads as belonging to the parent above it. */}
            <div
              className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 items-start"
              style={{ paddingLeft: `${(category._level || 0) * 1}rem` }}
            >
              <div className="min-w-0 flex items-center">{nameCell}</div>
              <div className="text-right whitespace-nowrap">
                <CellLabel>{t('list.colCount')}</CellLabel>
                <div className="text-sm text-gray-600 dark:text-gray-400">
                  {category.transactionCount ?? 0}
                </div>
              </div>
              <div className="col-span-2 flex items-start gap-3 min-w-0">
                <CategoryTypePill category={category} density={density} />
                {category.description && (
                  <div className="min-w-0 text-sm text-gray-500 dark:text-gray-400 break-words">
                    {category.description}
                  </div>
                )}
              </div>
            </div>
          </div>
        </td>
      </tr>
    );
  }

  return (
    <tr
      ref={rowRef}
      className={`group hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer select-none ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-table-stripe-dark' : 'bg-white dark:bg-gray-900'} ${isHighlighted ? HIGHLIGHT_FLASH : ''}`}
      {...getRowHandlers(category)}
    >
      <td className={`${cellPadding} whitespace-nowrap`}>
        <div
          className="flex items-center"
          style={{ paddingLeft: `${(category._level || 0) * (density === 'dense' ? 0.75 : 1.5)}rem` }}
        >
          {nameCell}
        </div>
      </td>
      <td className={`${cellPadding} whitespace-nowrap hidden sm:table-cell`}>
        <CategoryTypePill category={category} density={density} />
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
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm font-medium hidden min-[480px]:table-cell sticky right-0 ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-table-stripe-dark' : 'bg-white dark:bg-gray-900'} group-hover:bg-gray-100 dark:group-hover:bg-gray-800 ${isHighlighted ? HIGHLIGHT_FLASH_CELL : ''}`}>
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
  sortField?: SortField;
  sortDirection?: SortDirection;
  onSort?: (field: SortField) => void;
  /** Category id to flash/scroll to (e.g. arriving from a deep link). */
  highlightId?: string | null;
  /**
   * Why an empty list is empty: true when the user's search or type filter
   * hides every category, false when there are no categories at all. The
   * second is the first-run state, which offers the default set and a create.
   */
  isFiltered?: boolean;
  /** Opens the create dialog from the first-run empty state. */
  onCreate?: () => void;
  /** Opens the import-defaults dialog from the first-run empty state. */
  onImportDefaults?: () => void;
  /** An import of the default set is running. */
  isImporting?: boolean;
}

export function CategoryList({
  categories,
  onEdit,
  onRefresh,
  onDelete,
  sortField: propSortField,
  sortDirection: propSortDirection,
  onSort,
  highlightId,
  isFiltered = false,
  onCreate,
  onImportDefaults,
  isImporting = false,
}: CategoryListProps) {
  const t = useTranslations('categories');
  const tc = useTranslations('common');
  const router = useRouter();
  const [deleteCategory, setDeleteCategory] = useState<Category | null>(null);
  const [actionSheet, setActionSheet] = useState<{ open: boolean; category: Category | null }>({ open: false, category: null });
  const { density } = useDensityPreference('categories');
  const [localSortField, setLocalSortField] = useState<SortField>('name');
  const [localSortDirection, setLocalSortDirection] = useState<SortDirection>('asc');

  // Use prop sort state if provided (controlled), otherwise use local state
  const sortField = propSortField ?? localSortField;
  const sortDirection = propSortDirection ?? localSortDirection;


  const { cellPadding, headerPadding } = useTableDensity(density);
  // On a phone, density picks the LAYOUT rather than only the row height: at
  // Normal each category is a wrapped card carrying the type and count this
  // table hides below `sm`/`md`; Compact and Dense keep the tier table.
  const isMobile = useIsMobile();
  const wrapped = isMobile && density === 'normal';

  // One label per sortable column, read by both headers.
  const sortFieldLabels: Record<SortField, string> = {
    name: t('list.colName'),
    type: t('list.colType'),
    count: t('list.colCount'),
  };

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
  const sortProps = { sortField, sortDirection, onSort: handleSort };

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

  // A row click opens the category's detail page, matching the payees,
  // accounts and securities lists; Edit stays on the row actions and the
  // long-press sheet.
  const { getRowHandlers } = useLongPress<Category>({
    onLongPress: (category) => setActionSheet({ open: true, category }),
    onClick: (category) => router.push(`/categories/${category.id}`),
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
    const icon = <TagIcon />;
    if (isFiltered) {
      return (
        <EmptyState
          icon={icon}
          title={t('list.emptyHeading')}
          description={t('list.emptyDescription')}
        />
      );
    }
    return (
      <EmptyState
        icon={icon}
        title={t('empty.heading')}
        description={
          <>
            <p className="max-w-md mx-auto">{t('empty.description')}</p>
            <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">{t('empty.hint')}</p>
          </>
        }
        action={
          (onImportDefaults || onCreate) && (
            <div className="flex flex-col sm:flex-row justify-center gap-3">
              {onImportDefaults && (
                <Button onClick={onImportDefaults} isLoading={isImporting} disabled={isImporting}>
                  {t('empty.importButton')}
                </Button>
              )}
              {onCreate && (
                <Button variant="outline" onClick={onCreate} disabled={isImporting}>
                  {t('empty.createButton')}
                </Button>
              )}
            </div>
          )
        }
        help="categories"
      />
    );
  }

  return (
    <div>
      {/* Density toggle */}
      <DensityToggleBar view="categories" />
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          {/* On a phone the wrapped card labels its own values, so the column
              header is dropped, but its sort controls are not: a slim header
              carries every sort field as a button, and no column label of its
              own, because the one card cell holds every column at once. */}
          <thead className="bg-gray-50 dark:bg-gray-800">
            {wrapped ? (
            <tr>
              {/* Always sorted by something, and the buttons name every member
                  of `SortField`, so announcing the direction is honest. */}
              <th
                className={`${headerPadding} text-left`}
                aria-sort={sortDirection === 'asc' ? 'ascending' : 'descending'}
              >
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                  {SORT_FIELDS.map((field) => (
                    <button
                      key={field}
                      type="button"
                      onClick={() => handleSort(field)}
                      className="flex items-center text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider rounded focus-visible:outline-2 focus-visible:outline-blue-500"
                    >
                      {sortFieldLabels[field]}
                      <SortIcon field={field} sortField={sortField} sortDirection={sortDirection} />
                    </button>
                  ))}
                </div>
              </th>
            </tr>
            ) : (
            <tr>
              <SortableTh {...sortProps} field="name" className={headerPadding}>
                {sortFieldLabels.name}
              </SortableTh>
              <SortableTh {...sortProps} field="type" className={`${headerPadding} hidden sm:table-cell`}>
                {sortFieldLabels.type}
              </SortableTh>
              <SortableTh {...sortProps} field="count" align="right" className={`${headerPadding} hidden md:table-cell`}>
                {sortFieldLabels.count}
              </SortableTh>
              {density === 'normal' && (
                <Th className={headerPadding}>{t('list.colDescription')}</Th>
              )}
              <Th align="right" className={`${headerPadding} hidden min-[480px]:table-cell sticky right-0 bg-gray-50 dark:bg-gray-800`}>
                {t('list.colActions')}
              </Th>
            </tr>
            )}
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
                isHighlighted={!!highlightId && category.id === highlightId}
                wrapped={wrapped}
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
