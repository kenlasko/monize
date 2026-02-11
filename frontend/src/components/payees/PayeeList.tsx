'use client';

import { useState, useMemo, useCallback, memo } from 'react';
import { useRouter } from 'next/navigation';
import { Payee } from '@/types/payee';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { payeesApi } from '@/lib/payees';
import toast from 'react-hot-toast';
import { createLogger } from '@/lib/logger';

const logger = createLogger('PayeeList');

// Density levels: 'normal' | 'compact' | 'dense'
export type DensityLevel = 'normal' | 'compact' | 'dense';

export type SortField = 'name' | 'category' | 'count';
export type SortDirection = 'asc' | 'desc';

interface PayeeListProps {
  payees: Payee[];
  onEdit: (payee: Payee) => void;
  onRefresh: () => void;
  density?: DensityLevel;
  onDensityChange?: (density: DensityLevel) => void;
  sortField?: SortField;
  sortDirection?: SortDirection;
  onSort?: (field: SortField) => void;
}

interface PayeeRowProps {
  payee: Payee;
  density: DensityLevel;
  cellPadding: string;
  onEdit: (payee: Payee) => void;
  onDelete: (payee: Payee) => void;
  onViewTransactions: (payee: Payee) => void;
  index: number;
}

const PayeeRow = memo(function PayeeRow({
  payee,
  density,
  cellPadding,
  onEdit,
  onDelete,
  onViewTransactions,
  index,
}: PayeeRowProps) {
  const handleEdit = useCallback(() => {
    onEdit(payee);
  }, [onEdit, payee]);

  const handleDelete = useCallback(() => {
    onDelete(payee);
  }, [onDelete, payee]);

  const handleViewTransactions = useCallback(() => {
    onViewTransactions(payee);
  }, [onViewTransactions, payee]);

  return (
    <tr
      className={`hover:bg-gray-50 dark:hover:bg-gray-800 ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-gray-800/50' : ''}`}
    >
      <td className={`${cellPadding} whitespace-nowrap`}>
        <button
          onClick={handleViewTransactions}
          className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline text-left"
          title="View transactions with this payee"
        >
          {payee.name}
        </button>
      </td>
      <td className={`${cellPadding} whitespace-nowrap hidden sm:table-cell`}>
        {payee.defaultCategory ? (
          <span
            className={`inline-flex text-xs leading-5 font-semibold rounded-full ${density === 'dense' ? 'px-1.5 py-0.5' : 'px-2 py-1'}`}
            style={{
              backgroundColor: payee.defaultCategory.color
                ? `color-mix(in srgb, ${payee.defaultCategory.color} 15%, var(--category-bg-base, #e5e7eb))`
                : 'var(--category-bg-base, #e5e7eb)',
              color: payee.defaultCategory.color
                ? `color-mix(in srgb, ${payee.defaultCategory.color} 85%, var(--category-text-mix, #000))`
                : 'var(--category-text-base, #6b7280)',
            }}
          >
            {payee.defaultCategory.name}
          </span>
        ) : (
          <span className="text-sm text-gray-400 dark:text-gray-500">None</span>
        )}
      </td>
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm text-gray-600 dark:text-gray-400 hidden md:table-cell`}>
        {payee.transactionCount ?? 0}
      </td>
      {density === 'normal' && (
        <td className={`${cellPadding}`}>
          <div className="text-sm text-gray-500 dark:text-gray-400 max-w-xs truncate">
            {payee.notes || '-'}
          </div>
        </td>
      )}
      <td className={`${cellPadding} whitespace-nowrap text-right text-sm font-medium`}>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleEdit}
          className="text-blue-600 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-300 mr-2"
        >
          {density === 'dense' ? '✎' : 'Edit'}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={handleDelete}
          className="text-red-600 dark:text-red-400 hover:text-red-900 dark:hover:text-red-300"
        >
          {density === 'dense' ? '✕' : 'Delete'}
        </Button>
      </td>
    </tr>
  );
});

export function PayeeList({
  payees,
  onEdit,
  onRefresh,
  density: propDensity,
  onDensityChange,
  sortField: propSortField,
  sortDirection: propSortDirection,
  onSort,
}: PayeeListProps) {
  const router = useRouter();
  const [deletePayee, setDeletePayee] = useState<Payee | null>(null);
  const [localDensity, setLocalDensity] = useState<DensityLevel>('normal');
  const [localSortField, setLocalSortField] = useState<SortField>('name');
  const [localSortDirection, setLocalSortDirection] = useState<SortDirection>('asc');

  // Use prop sort state if provided (controlled), otherwise use local state
  const sortField = propSortField ?? localSortField;
  const sortDirection = propSortDirection ?? localSortDirection;

  // Use prop density if provided, otherwise use local state
  const density = propDensity ?? localDensity;

  // Memoize padding classes based on density
  const cellPadding = useMemo(() => {
    switch (density) {
      case 'dense': return 'px-3 py-1';
      case 'compact': return 'px-4 py-2';
      default: return 'px-6 py-4';
    }
  }, [density]);

  const headerPadding = useMemo(() => {
    switch (density) {
      case 'dense': return 'px-3 py-2';
      case 'compact': return 'px-4 py-2';
      default: return 'px-6 py-3';
    }
  }, [density]);

  const cycleDensity = useCallback(() => {
    const nextDensity = density === 'normal' ? 'compact' : density === 'compact' ? 'dense' : 'normal';
    if (onDensityChange) {
      onDensityChange(nextDensity);
    } else {
      setLocalDensity(nextDensity);
    }
  }, [density, onDensityChange]);

  const handleSort = useCallback((field: SortField) => {
    if (onSort) {
      // Controlled mode - let parent handle sort
      onSort(field);
    } else {
      // Uncontrolled mode - manage sort locally
      if (localSortField === field) {
        setLocalSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      } else {
        setLocalSortField(field);
        setLocalSortDirection(field === 'count' ? 'desc' : 'asc');
      }
    }
  }, [onSort, localSortField]);

  // Only sort locally if not controlled (parent passes pre-sorted data when controlled)
  const displayPayees = useMemo(() => {
    if (onSort) {
      // Controlled mode - payees are already sorted by parent
      return payees;
    }
    // Uncontrolled mode - sort locally
    return [...payees].sort((a, b) => {
      let comparison = 0;
      if (sortField === 'name') {
        comparison = a.name.localeCompare(b.name);
      } else if (sortField === 'category') {
        const catA = a.defaultCategory?.name || '';
        const catB = b.defaultCategory?.name || '';
        comparison = catA.localeCompare(catB);
      } else if (sortField === 'count') {
        comparison = (a.transactionCount ?? 0) - (b.transactionCount ?? 0);
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });
  }, [payees, sortField, sortDirection, onSort]);

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) {
      return <span className="ml-1 text-gray-300 dark:text-gray-600">↕</span>;
    }
    return <span className="ml-1">{sortDirection === 'asc' ? '↑' : '↓'}</span>;
  };

  const handleViewTransactions = useCallback((payee: Payee) => {
    router.push(`/transactions?payeeId=${payee.id}`);
  }, [router]);

  const handleConfirmDelete = async () => {
    if (!deletePayee) return;

    try {
      await payeesApi.delete(deletePayee.id);
      toast.success('Payee deleted successfully');
      onRefresh();
    } catch (error) {
      toast.error('Failed to delete payee');
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
        <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">No payees</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Get started by creating a new payee.</p>
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
          title="Toggle row density"
        >
          <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
          {density === 'normal' ? 'Normal' : density === 'compact' ? 'Compact' : 'Dense'}
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
                Name<SortIcon field="name" />
              </th>
              <th
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 hidden sm:table-cell`}
                onClick={() => handleSort('category')}
              >
                Default Category<SortIcon field="category" />
              </th>
              <th
                className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 hidden md:table-cell`}
                onClick={() => handleSort('count')}
              >
                Count<SortIcon field="count" />
              </th>
              {density === 'normal' && (
                <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                  Notes
                </th>
              )}
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Actions
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
                onViewTransactions={handleViewTransactions}
                index={index}
              />
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        isOpen={deletePayee !== null}
        title={`Delete "${deletePayee?.name}"?`}
        message="This action cannot be undone."
        confirmLabel="Delete"
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleConfirmDelete}
        onCancel={() => setDeletePayee(null)}
      />
    </div>
  );
}
