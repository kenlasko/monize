'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Payee } from '@/types/payee';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { payeesApi } from '@/lib/payees';
import toast from 'react-hot-toast';

interface PayeeListProps {
  payees: Payee[];
  onEdit: (payee: Payee) => void;
  onRefresh: () => void;
}

export function PayeeList({ payees, onEdit, onRefresh }: PayeeListProps) {
  const router = useRouter();
  const [deletePayee, setDeletePayee] = useState<Payee | null>(null);

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
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead className="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Name
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Default Category
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Notes
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
          {payees.map((payee) => (
            <tr key={payee.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
              <td className="px-6 py-4 whitespace-nowrap">
                <button
                  onClick={() => handleViewTransactions(payee)}
                  className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline text-left"
                  title="View transactions with this payee"
                >
                  {payee.name}
                </button>
              </td>
              <td className="px-6 py-4 whitespace-nowrap">
                {payee.defaultCategory ? (
                  <span
                    className="px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full"
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
              <td className="px-6 py-4">
                <div className="text-sm text-gray-500 dark:text-gray-400 max-w-xs truncate">
                  {payee.notes || '-'}
                </div>
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onEdit(payee)}
                  className="text-blue-600 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-300 mr-2"
                >
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setDeletePayee(payee)}
                  className="text-red-600 dark:text-red-400 hover:text-red-900 dark:hover:text-red-300"
                >
                  Delete
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

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
