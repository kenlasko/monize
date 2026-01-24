'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Category } from '@/types/category';
import { Button } from '@/components/ui/Button';
import { DeleteCategoryDialog } from './DeleteCategoryDialog';
import { categoriesApi } from '@/lib/categories';
import toast from 'react-hot-toast';

interface CategoryListProps {
  categories: Category[];
  onEdit: (category: Category) => void;
  onRefresh: () => void;
}

export function CategoryList({ categories, onEdit, onRefresh }: CategoryListProps) {
  const router = useRouter();
  const [deleteCategory, setDeleteCategory] = useState<Category | null>(null);

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

  // Build tree structure
  const buildTree = (parentId: string | null = null, level: number = 0): Category[] => {
    return categories
      .filter((c) => c.parentId === parentId)
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((category) => [
        { ...category, _level: level },
        ...buildTree(category.id, level + 1),
      ]);
  };

  const treeCategories = buildTree();

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
    <div className="overflow-x-auto">
      <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
        <thead className="bg-gray-50 dark:bg-gray-800">
          <tr>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Name
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Type
            </th>
            <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Description
            </th>
            <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Actions
            </th>
          </tr>
        </thead>
        <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
          {treeCategories.map((category: Category & { _level?: number }) => (
            <tr key={category.id} className="hover:bg-gray-50 dark:hover:bg-gray-800">
              <td className="px-6 py-4 whitespace-nowrap">
                <div
                  className="flex items-center"
                  style={{ paddingLeft: `${(category._level || 0) * 1.5}rem` }}
                >
                  {category.color && (
                    <span
                      className="w-3 h-3 rounded-full mr-2 flex-shrink-0"
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
                  {category.isSystem && (
                    <span className="ml-2 text-xs text-gray-400 dark:text-gray-500">(System)</span>
                  )}
                </div>
              </td>
              <td className="px-6 py-4 whitespace-nowrap">
                <span
                  className={`px-2 py-1 inline-flex text-xs leading-5 font-semibold rounded-full ${
                    category.isIncome
                      ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                      : 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200'
                  }`}
                >
                  {category.isIncome ? 'Income' : 'Expense'}
                </span>
              </td>
              <td className="px-6 py-4">
                <div className="text-sm text-gray-500 dark:text-gray-400 max-w-xs truncate">
                  {category.description || '-'}
                </div>
              </td>
              <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => onEdit(category)}
                  className="text-blue-600 dark:text-blue-400 hover:text-blue-900 dark:hover:text-blue-300 mr-2"
                >
                  Edit
                </Button>
                {!category.isSystem && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDeleteClick(category)}
                    className="text-red-600 dark:text-red-400 hover:text-red-900 dark:hover:text-red-300"
                  >
                    Delete
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

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
