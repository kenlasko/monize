'use client';

import { useState, useEffect } from 'react';
import { Category } from '@/types/category';
import { Button } from '@/components/ui/Button';
import { categoriesApi } from '@/lib/categories';
import { buildCategoryTree } from '@/lib/categoryUtils';

interface DeleteCategoryDialogProps {
  isOpen: boolean;
  category: Category | null;
  categories: Category[];
  onConfirm: (reassignToCategoryId: string | null) => void;
  onCancel: () => void;
}

export function DeleteCategoryDialog({
  isOpen,
  category,
  categories,
  onConfirm,
  onCancel,
}: DeleteCategoryDialogProps) {
  const [transactionCount, setTransactionCount] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [reassignTo, setReassignTo] = useState<string>('');

  useEffect(() => {
    if (isOpen && category) {
      setIsLoading(true);
      setReassignTo('');
      categoriesApi
        .getTransactionCount(category.id)
        .then(setTransactionCount)
        .catch(() => setTransactionCount(0))
        .finally(() => setIsLoading(false));
    }
  }, [isOpen, category]);

  if (!isOpen || !category) return null;

  // Get available categories to reassign to (excluding current and its children)
  const getAvailableCategories = () => {
    const excludeIds = new Set<string>();
    const collectChildren = (parentId: string) => {
      categories.forEach((c) => {
        if (c.parentId === parentId) {
          excludeIds.add(c.id);
          collectChildren(c.id);
        }
      });
    };

    excludeIds.add(category.id);
    collectChildren(category.id);

    return buildCategoryTree(categories, excludeIds);
  };

  const availableCategories = getAvailableCategories();

  const handleConfirm = () => {
    onConfirm(reassignTo || null);
  };

  return (
    <div className="fixed inset-0 bg-gray-500 dark:bg-gray-900 bg-opacity-75 dark:bg-opacity-80 flex items-center justify-center p-4 z-50">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl dark:shadow-gray-700/50 max-w-md w-full p-6">
        <div className="flex items-start">
          <div className="flex-shrink-0 flex items-center justify-center h-10 w-10 rounded-full bg-red-100 dark:bg-red-900 text-red-600 dark:text-red-400">
            <svg
              className="h-6 w-6"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
              />
            </svg>
          </div>
          <div className="ml-4 flex-1">
            <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100">
              Delete "{category.name}"?
            </h3>

            {isLoading ? (
              <div className="mt-2 flex items-center text-sm text-gray-500 dark:text-gray-400">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-400 dark:border-gray-500 mr-2"></div>
                Checking usage...
              </div>
            ) : transactionCount && transactionCount > 0 ? (
              <div className="mt-2">
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  This category is used by{' '}
                  <span className="font-semibold text-gray-700 dark:text-gray-300">
                    {transactionCount} item{transactionCount !== 1 ? 's' : ''}
                  </span>
                  {' '}(transactions and/or scheduled bills & deposits).
                </p>

                <div className="mt-4">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                    Reassign to:
                  </label>
                  <select
                    value={reassignTo}
                    onChange={(e) => setReassignTo(e.target.value)}
                    className="block w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:focus:border-blue-400 dark:focus:ring-blue-400 font-sans text-sm dark:bg-gray-700 dark:text-gray-100"
                  >
                    <option value="">Leave uncategorized</option>
                    {availableCategories.map(({ category: cat }) => {
                      const parentCategory = cat.parentId
                        ? categories.find(c => c.id === cat.parentId)
                        : null;
                      const displayName = parentCategory
                        ? `${parentCategory.name}: ${cat.name}`
                        : cat.name;
                      return (
                        <option key={cat.id} value={cat.id}>
                          {displayName}
                        </option>
                      );
                    })}
                  </select>
                </div>
              </div>
            ) : (
              <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">
                This category is not used. It can be safely deleted.
              </p>
            )}

            <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
              This action cannot be undone.
            </p>
          </div>
        </div>

        <div className="mt-6 flex justify-end space-x-3">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <button
            onClick={handleConfirm}
            disabled={isLoading}
            className="inline-flex justify-center px-4 py-2 text-sm font-medium text-white bg-red-600 dark:bg-red-700 border border-transparent rounded-md hover:bg-red-700 dark:hover:bg-red-600 focus:outline-none focus:ring-2 focus:ring-offset-2 dark:focus:ring-offset-gray-800 focus:ring-red-500 disabled:opacity-50"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}
