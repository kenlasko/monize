'use client';

import { useState, useMemo, useCallback, memo } from 'react';
import { useTranslations } from 'next-intl';
import { Tag } from '@/types/tag';
import { getIconComponent } from '@/components/ui/IconPicker';
import { useTableDensity, nextDensity, type DensityLevel } from '@/hooks/useTableDensity';
import { SortIcon } from '@/components/ui/SortIcon';
import { useLongPress, type LongPressRowHandlers } from '@/hooks/useLongPress';
import { RowActions } from '@/components/ui/row-actions/RowActions';
import { RowActionSheet } from '@/components/ui/row-actions/RowActionSheet';
import type { RowAction } from '@/components/ui/row-actions/rowAction';

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

export type SortField = 'name' | 'createdAt';
export type SortDirection = 'asc' | 'desc';

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
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm text-gray-500 dark:text-gray-400 hidden sm:table-cell`}>
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
  density?: DensityLevel;
  onDensityChange?: (density: DensityLevel) => void;
  sortField?: SortField;
  sortDirection?: SortDirection;
  onSort?: (field: SortField) => void;
}

export function TagList({
  tags,
  transactionCounts,
  onEdit,
  onDelete,
  onTagClick,
  density: propDensity,
  onDensityChange,
  sortField: propSortField,
  sortDirection: propSortDirection,
  onSort,
}: TagListProps) {
  const t = useTranslations('tags');
  const tc = useTranslations('common');
  const [actionSheet, setActionSheet] = useState<{ open: boolean; tag: Tag | null }>({ open: false, tag: null });
  const [localDensity, setLocalDensity] = useState<DensityLevel>('normal');
  const [localSortField, setLocalSortField] = useState<SortField>('name');
  const [localSortDirection, setLocalSortDirection] = useState<SortDirection>('asc');

  const sortField = propSortField ?? localSortField;
  const sortDirection = propSortDirection ?? localSortDirection;
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
        setLocalSortDirection('asc');
      }
    }
  }, [onSort, localSortField]);

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
      } else if (sortField === 'createdAt') {
        comparison = new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [tags, sortField, sortDirection]);

  if (tags.length === 0) {
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
        <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">{t('list.empty.title')}</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('list.empty.body')}</p>
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
          title={t('list.density.title')}
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
                {t('list.header.name')}<SortIcon field="name" sortField={sortField} sortDirection={sortDirection} />
              </th>
              <th
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell`}
              >
                {t('list.header.icon')}
              </th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden sm:table-cell`}>
                {t('list.header.transactions')}
              </th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden min-[480px]:table-cell sticky right-0 bg-gray-50 dark:bg-gray-800`}>
                {t('list.header.actions')}
              </th>
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
