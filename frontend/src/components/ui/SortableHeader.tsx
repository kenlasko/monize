'use client';

import { ReactNode } from 'react';
import { SortIcon } from './SortIcon';
import type { SortDirection } from '@/hooks/useSortableTable';

interface SortableHeaderProps<F extends string> {
  field: F;
  sortField: F;
  sortDirection: SortDirection;
  onSort: (field: F) => void;
  align?: 'left' | 'right' | 'center';
  className?: string;
  children: ReactNode;
}

/**
 * Clickable column header with a sort indicator. Mirrors the style used by the
 * Accounts table so all reports sort consistently.
 */
export function SortableHeader<F extends string>({
  field,
  sortField,
  sortDirection,
  onSort,
  align = 'left',
  className = '',
  children,
}: SortableHeaderProps<F>) {
  const justify =
    align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : '';
  return (
    <th
      onClick={() => onSort(field)}
      className={`cursor-pointer transition-colors motion-reduce:transition-none hover:bg-gray-100 dark:hover:bg-gray-700 select-none ${className}`}
    >
      <div className={`flex items-center ${justify}`}>
        {children}
        <SortIcon field={field} sortField={sortField} sortDirection={sortDirection} />
      </div>
    </th>
  );
}
