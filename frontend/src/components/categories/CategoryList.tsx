'use client';

import { useState, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { Category } from '@/types/category';
import { Button } from '@/components/ui/Button';
import { DeleteCategoryDialog } from './DeleteCategoryDialog';
import { categoriesApi } from '@/lib/categories';
import toast from 'react-hot-toast';

// Density levels: 'normal' | 'compact' | 'dense'
export type DensityLevel = 'normal' | 'compact' | 'dense';

type SortField = 'name' | 'type' | 'count';
type SortDirection = 'asc' | 'desc';

interface CategoryListProps {
  categories: Category[];
  onEdit: (category: Category) => void;
  onRefresh: () => void;
  density?: DensityLevel;
  onDensityChange?: (density: DensityLevel) => void;
}

export function CategoryList({
  categories,
  onEdit,
  onRefresh,
  density: propDensity,
  onDensityChange,
}: CategoryListProps) {
  const router = useRouter();
  const [deleteCategory, setDeleteCategory] = useState<Category | null>(null);
  const [localDensity, setLocalDensity] = useState<DensityLevel>('normal');
  const [sortField, setSortField] = useState<SortField>('name');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');

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
    if (sortField === field) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection(field === 'count' ? 'desc' : 'asc');
    }
  }, [sortField]);

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) {
      return <span className="ml-1 text-gray-300 dark:text-gray-600">↕</span>;
    }
    return <span className="ml-1">{sortDirection === 'asc' ? '↑' : '↓'}</span>;
  };

  const handleViewTransactions = (category: Category) => {
    router.push(`/transactions?categoryId=${category.id}`);
  };

  const handleDeleteClick = (category: Category) => {
    if (category.isSystem) {
      toast.error('System categories cannot be deleted');
      return;
    }
    setDeleteCategory(category);
  };

  const handleConfirmDelete = async (reassignToCategoryId: string | null) => {
    if (!deleteCategory) return;

    try {
      // Check if there are transactions to reassign
      const count = await categoriesApi.getTransactionCount(deleteCategory.id);
      if (count > 0) {
        await categoriesApi.reassignTransactions(deleteCategory.id, reassignToCategoryId);
      }

      await categoriesApi.delete(deleteCategory.id);
      toast.success('Category deleted successfully');
      onRefresh();
    } catch (error: any) {
      const message = error.response?.data?.message || 'Failed to delete category';
      toast.error(message);
      console.error(error);
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
        <h3 className="mt-2 text-sm font-medium text-gray-900 dark:text-gray-100">No categories</h3>
        <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Get started by creating a new category.</p>
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
                onClick={() => handleSort('type')}
              >
                Type<SortIcon field="type" />
              </th>
              <th
                className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:text-gray-700 dark:hover:text-gray-200 hidden md:table-cell`}
                onClick={() => handleSort('count')}
              >
                Count<SortIcon field="count" />
              </th>
              {density === 'normal' && (
                <th className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                  Description
                </th>
              )}
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider`}>
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
            {treeCategories.map((category: Category & { _level?: number }, index) => (
              <tr
                key={category.id}
                className={`hover:bg-gray-50 dark:hover:bg-gray-800 ${density !== 'normal' && index % 2 === 1 ? 'bg-gray-50 dark:bg-gray-800/50' : ''}`}
              >
                <td className={`${cellPadding} whitespace-nowrap`}>
                  <div
                    className="flex items-center"
                    style={{ paddingLeft: `${(category._level || 0) * (density === 'dense' ? 0.75 : 1.5)}rem` }}
                  >
                    {category.color && (
                      <span
                        className={`rounded-full mr-2 flex-shrink-0 ${density === 'dense' ? 'w-2 h-2' : 'w-3 h-3'}`}
                        style={{ backgroundColor: category.color }}
                      />
                    )}
                    <button
                      onClick={() => handleViewTransactions(category)}
                      className="text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 hover:underline text-left"
                      title="View transactions in this category"
                    >
                      {category.name}
                    </button>
                    {category.isSystem && density !== 'dense' && (
                      <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">(System)</span>
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
                    {category.isIncome ? 'Income' : 'Expense'}
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
                <td className={`${cellPadding} whitespace-nowrap text-right text-sm font-medium`}>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => onEdit(category)}
                    className="text-blue-600 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-300 mr-2"
                  >
                    {density === 'dense' ? '✎' : 'Edit'}
                  </Button>
                  {!category.isSystem && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteClick(category)}
                      className="text-red-600 dark:text-red-400 hover:text-red-900 dark:hover:text-red-300"
                    >
                      {density === 'dense' ? '✕' : 'Delete'}
                    </Button>
                  )}
                </td>
              </tr>
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
    </div>
  );
}
