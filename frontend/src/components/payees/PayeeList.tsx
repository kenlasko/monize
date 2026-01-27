'use client';

import { useState, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Payee } from '@/types/payee';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { payeesApi } from '@/lib/payees';
import toast from 'react-hot-toast';

// Density levels: 'normal' | 'compact' | 'dense'
export type DensityLevel = 'normal' | 'compact' | 'dense';

interface PayeeListProps {
  payees: Payee[];
  onEdit: (payee: Payee) => void;
  onRefresh: () => void;
  density?: DensityLevel;
  onDensityChange?: (density: DensityLevel) => void;
}

export function PayeeList({
  payees,
  onEdit,
  onRefresh,
  density: propDensity,
  onDensityChange,
}: PayeeListProps) {
  const router = useRouter();
  const [deletePayee, setDeletePayee] = useState<Payee | null>(null);
  const [localDensity, setLocalDensity] = useState<DensityLevel>('normal');

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

  const handleViewTransactions = (payee: Payee) => {
    router.push(`/transactions?payeeId=${payee.id}`);
  };

  const handleConfirmDelete = async () => {
    if (!deletePayee) return;

    try {
      await payeesApi.delete(deletePayee.id);
      toast.success('Payee deleted successfully');
      onRefresh();
    } catch (error) {
      toast.error('Failed to delete payee');
      console.error(error);
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
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Name
              </th>
              <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Default Category
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
            {payees.map((payee, index) => (
              <tr
                key={payee.id}
                className={`hover:bg-gray-50 dark:hover:bg-gray-800 ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-gray-800/50' : ''}`}
              >
                <td className={`${cellPadding} whitespace-nowrap`}>
                  <button
                    onClick={() => handleViewTransactions(payee)}
                    className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline text-left"
                    title="View transactions with this payee"
                  >
                    {payee.name}
                  </button>
                </td>
                <td className={`${cellPadding} whitespace-nowrap`}>
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
                    onClick={() => onEdit(payee)}
                    className="text-blue-600 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-300 mr-2"
                  >
                    {density === 'dense' ? '✎' : 'Edit'}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDeletePayee(payee)}
                    className="text-red-600 dark:text-red-400 hover:text-red-900 dark:hover:text-red-300"
                  >
                    {density === 'dense' ? '✕' : 'Delete'}
                  </Button>
                </td>
              </tr>
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
