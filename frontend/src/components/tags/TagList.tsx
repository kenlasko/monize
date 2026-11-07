'use client';

import { useState, useMemo, useCallback, memo } from 'react';
import { useTranslations } from 'next-intl';
import { Tag } from '@/types/tag';
import { getIconComponent } from '@/components/ui/IconPicker';
import { useTableDensity, type DensityLevel } from '@/hooks/useTableDensity';
import { useDensityPreference } from '@/store/densityStore';
import { useLongPress, type LongPressRowHandlers } from '@/hooks/useLongPress';
import { RowActions } from '@/components/ui/row-actions/RowActions';
import { RowActionSheet } from '@/components/ui/row-actions/RowActionSheet';
import type { RowAction } from '@/components/ui/row-actions/rowAction';
import { DensityToggleBar } from '@/components/ui/DensityToggle';
import { EmptyState } from '@/components/ui/EmptyState';
import { Button } from '@/components/ui/Button';
import { SortableTh, Th } from '@/components/ui/Table';
import { TagIcon } from '@heroicons/react/24/outline';

export type { DensityLevel } from '@/hooks/useTableDensity';

/**
 * Builds the standard row actions for a tag. Shared by the desktop `RowActions`
 * cell and the mobile `RowActionSheet`.
 */
function buildTagActions(
  tag: Tag,
  labels: { edit: string; delete: string },
  handlers: { onEdit: (tag: Tag) => void; onDeleteClick: (tag: Tag) => void },
): RowAction[] {
  return [
    { key: 'edit', label: labels.edit, icon: 'edit', tone: 'primary', onClick: () => handlers.onEdit(tag) },
    { key: 'delete', label: labels.delete, icon: 'delete', tone: 'delete', destructive: true, onClick: () => handlers.onDeleteClick(tag) },
  ];
}

export type SortField = 'name' | 'count';
export type SortDirection = 'asc' | 'desc';

/**
 * A stored sort field this list can still draw a control for. The sort is
 * remembered in local storage (`monize-tags-sort-field`), and a value an older
 * build wrote (`createdAt`, which no header ever offered) would otherwise
 * leave the list in an order no button names.
 */
function isTagSortField(value: unknown): value is SortField {
  return value === 'name' || value === 'count';
}

interface TagRowProps {
  tag: Tag;
  transactionCount: number;
  density: DensityLevel;
  cellPadding: string;
  onEdit: (tag: Tag) => void;
  onDeleteClick: (tag: Tag) => void;
  onTagClick?: (tag: Tag) => void;
  index: number;
  getRowHandlers: (tag: Tag) => LongPressRowHandlers;
}

const TagRow = memo(function TagRow({
  tag,
  transactionCount,
  density,
  cellPadding,
  onEdit,
  onDeleteClick,
  onTagClick,
  index,
  getRowHandlers,
}: TagRowProps) {
  const tc = useTranslations('common');

  const handleTagClick = useCallback(() => {
    onTagClick?.(tag);
  }, [onTagClick, tag]);

  const actions = useMemo(
    () => buildTagActions(tag, { edit: tc('actions.edit'), delete: tc('actions.delete') }, { onEdit, onDeleteClick }),
    [tag, tc, onEdit, onDeleteClick],
  );

  return (
    <tr
      className={`group hover:bg-gray-100 dark:hover:bg-gray-800 cursor-pointer select-none ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-table-stripe-dark' : 'bg-white dark:bg-gray-900'}`}
      {...getRowHandlers(tag)}
    >
      <td className={`${cellPadding} whitespace-nowrap`}>
        <div className="flex items-center">
          {tag.color && (
            <span
              className={`rounded-full mr-2 flex-shrink-0 ${density === 'dense' ? 'w-2 h-2' : 'w-3 h-3'}`}
              style={{ backgroundColor: tag.color }}
            />
          )}
          {onTagClick ? (
            <button
              onClick={(e) => { e.stopPropagation(); handleTagClick(); }}
              className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline"
            >
              {tag.name}
            </button>
          ) : (
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {tag.name}
            </span>
          )}
        </div>
      </td>
      <td className={`${cellPadding} whitespace-nowrap hidden sm:table-cell`}>
        {tag.icon ? (
          <span className="text-gray-600 dark:text-gray-400 [&>svg]:w-5 [&>svg]:h-5">
            {getIconComponent(tag.icon)}
          </span>
        ) : (
          <span className="text-sm text-gray-400 dark:text-gray-500">-</span>
        )}
      </td>
      {/* Shown at every width: on a phone the count is what a tag row has to
          say beyond its name (the icon is decoration), and a one-figure column
          fits beside the name where the four-cell card it replaced did not. */}
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm text-gray-500 dark:text-gray-400`}>
        {transactionCount}
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm font-medium hidden min-[480px]:table-cell sticky right-0 ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-table-stripe-dark' : 'bg-white dark:bg-gray-900'} group-hover:bg-gray-100 dark:group-hover:bg-gray-800`}>
        <RowActions actions={actions} density={density} />
      </td>
    </tr>
  );
});

interface TagListProps {
  tags: Tag[];
  transactionCounts?: Record<string, number>;
  onEdit: (tag: Tag) => void;
  onDelete: (tag: Tag) => void;
  onTagClick?: (tag: Tag) => void;
  sortField?: SortField;
  sortDirection?: SortDirection;
  onSort?: (field: SortField) => void;
  /**
   * Why an empty list is empty: true when the search hides every tag, false
   * when there are no tags at all (the first-run state, which offers a create).
   */
  isFiltered?: boolean;
  /** Opens the create dialog from the first-run empty state. */
  onCreate?: () => void;
}

export function TagList({
  tags,
  transactionCounts,
  onEdit,
  onDelete,
  onTagClick,
  sortField: propSortField,
  sortDirection: propSortDirection,
  onSort,
  isFiltered = false,
  onCreate,
}: TagListProps) {
  const t = useTranslations('tags');
  const tc = useTranslations('common');
  const [actionSheet, setActionSheet] = useState<{ open: boolean; tag: Tag | null }>({ open: false, tag: null });
  const { density } = useDensityPreference('tags');
  const [localSortField, setLocalSortField] = useState<SortField>('name');
  const [localSortDirection, setLocalSortDirection] = useState<SortDirection>('asc');

  const requestedSortField = propSortField ?? localSortField;
  const sortField: SortField = isTagSortField(requestedSortField) ? requestedSortField : 'name';
  const sortDirection = propSortDirection ?? localSortDirection;

  const { cellPadding, headerPadding } = useTableDensity(density);
  // No phone card here, unlike the other lists: the maintainer's device review
  // dropped it. The Transactions column shows at every width, and the name and
  // the count are all a tag row has to say on a phone.

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

  const handleDeleteClick = useCallback((tag: Tag) => {
    onDelete(tag);
  }, [onDelete]);

  const { getRowHandlers } = useLongPress<Tag>({
    onLongPress: (tag) => setActionSheet({ open: true, tag }),
    onClick: onEdit,
  });

  const sortedTags = useMemo(() => {
    return [...tags].sort((a, b) => {
      let comparison = 0;
      if (sortField === 'name') {
        comparison = a.name.localeCompare(b.name);
      } else if (sortField === 'count') {
        comparison = (transactionCounts?.[a.id] ?? 0) - (transactionCounts?.[b.id] ?? 0);
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [tags, sortField, sortDirection, transactionCounts]);

  if (tags.length === 0) {
    return isFiltered ? (
      <EmptyState
        icon={<TagIcon />}
        title={t('list.empty.title')}
        description={t('list.empty.body')}
      />
    ) : (
      <EmptyState
        icon={<TagIcon />}
        title={t('page.emptyState.title')}
        description={t('page.emptyState.body')}
        action={
          onCreate && (
            <Button onClick={onCreate}>{t('page.emptyState.createButton')}</Button>
          )
        }
        help="tags"
      />
    );
  }

  return (
    <div>
      {/* Density toggle */}
      <DensityToggleBar view="tags" />
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-800">
            <tr>
              <SortableTh {...sortProps} field="name" className={headerPadding}>
                {t('list.header.name')}
              </SortableTh>
              <Th className={`${headerPadding} hidden sm:table-cell`}>{t('list.header.icon')}</Th>
              <SortableTh {...sortProps} field="count" align="right" className={headerPadding}>
                {t('list.header.transactions')}
              </SortableTh>
              <Th align="right" className={`${headerPadding} hidden min-[480px]:table-cell sticky right-0 bg-gray-50 dark:bg-gray-800`}>
                {t('list.header.actions')}
              </Th>
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
            {sortedTags.map((tag, index) => (
              <TagRow
                key={tag.id}
                tag={tag}
                transactionCount={transactionCounts?.[tag.id] ?? 0}
                density={density}
                cellPadding={cellPadding}
                onEdit={onEdit}
                onDeleteClick={handleDeleteClick}
                onTagClick={onTagClick}
                index={index}
                getRowHandlers={getRowHandlers}
              />
            ))}
          </tbody>
        </table>
      </div>

      <RowActionSheet
        isOpen={actionSheet.open}
        title={actionSheet.tag?.name ?? ''}
        actions={actionSheet.tag
          ? buildTagActions(actionSheet.tag, { edit: tc('actions.edit'), delete: tc('actions.delete') }, { onEdit, onDeleteClick: handleDeleteClick })
          : []}
        onClose={() => setActionSheet({ open: false, tag: null })}
      />
    </div>
  );
}
