'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Category } from '@/types/category';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { categoriesApi } from '@/lib/categories';
import type { CategoryUsage } from '@/lib/categories';
import { buildCategoryTree } from '@/lib/categoryUtils';

interface DeleteCategoryDialogProps {
  isOpen: boolean;
  category: Category | null;
  categories: Category[];
  /** `undefined` when nothing uses the category, so nothing is moved. */
  onConfirm: (reassignToCategoryId?: string | null) => void;
  onCancel: () => void;
}

export function DeleteCategoryDialog({
  isOpen,
  category,
  categories,
  onConfirm,
  onCancel,
}: DeleteCategoryDialogProps) {
  const t = useTranslations('categories');
  const tc = useTranslations('common');
  const [usage, setUsage] = useState<CategoryUsage | null>(null);
  // The lookup failed: usage is unknown, which is not the same as unused.
  const [usageFailed, setUsageFailed] = useState(false);
  const [reassignTo, setReassignTo] = useState<string>('');

  // Reset state during render when category changes
  const categoryId = isOpen && category ? category.id : null;
  const [prevCategoryId, setPrevCategoryId] = useState<string | null>(null);
  if (categoryId !== prevCategoryId) {
    setPrevCategoryId(categoryId);
    if (categoryId) {
      setUsage(null);
      setUsageFailed(false);
      setReassignTo('');
    }
  }

  const isLoading = isOpen && categoryId !== null && usage === null && !usageFailed;

  // Every open starts from "unknown" (the render-time reset above, which also
  // runs on a reopen of the same category) and one lookup answers it. A late
  // answer from an earlier open is dropped, so it cannot overwrite this one.
  useEffect(() => {
    if (!isOpen || !category) return;
    let current = true;
    categoriesApi
      .getUsage(category.id)
      .then((result) => {
        if (!current) return;
        setUsageFailed(false);
        setUsage(result);
      })
      .catch(() => {
        if (!current) return;
        setUsage(null);
        setUsageFailed(true);
      });
    return () => {
      current = false;
    };
  }, [isOpen, category]);

  // Get available categories to reassign to (excluding current and its children)
  const getAvailableCategories = () => {
    if (!category) return [];

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

  // Nothing to move: a plain delete, which an acting delegate may also run.
  const handleConfirm = () => {
    // Only rows a reassign moves are offered a target; anything else that
    // uses the category stays, so a plain delete lets the server list it.
    onConfirm(!usageFailed && usage?.movableCount ? reassignTo || null : undefined);
  };

  // Don't render if no category (Modal handles isOpen check)
  if (!category) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      maxWidth="md"
      className="p-6"
      title={t('deleteDialog.title', { name: category.name })}
    >
      {/* Not a ConfirmDialog: the body holds the reassignment picker, which a
          confirmation's one paragraph cannot. */}
      {isLoading ? (
        <div className="flex items-center text-sm text-gray-500 dark:text-gray-400">
          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-gray-400 dark:border-gray-500 mr-2"></div>
          {t('deleteDialog.checkingUsage')}
        </div>
      ) : usageFailed ? (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('deleteDialog.usageUnknown')}
        </p>
      ) : usage && usage.count > 0 ? (
        <div>
          <p className="text-sm text-gray-500 dark:text-gray-400">
            {t('deleteDialog.usedBy', { count: usage.count })}
          </p>

          {usage.movableCount > 0 && (
          <div className="mt-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('deleteDialog.reassignLabel')}
            </label>
            <select
              value={reassignTo}
              onChange={(e) => setReassignTo(e.target.value)}
              className="block w-full rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:focus:border-blue-400 dark:focus:ring-blue-400 font-sans text-sm dark:bg-gray-700 dark:text-gray-100"
            >
              <option value="">{t('deleteDialog.leaveUncategorized')}</option>
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
          )}
        </div>
      ) : (
        <p className="text-sm text-gray-500 dark:text-gray-400">
          {t('deleteDialog.safeToDelete')}
        </p>
      )}

      <p className="mt-3 text-sm text-gray-500 dark:text-gray-400">
        {t('deleteDialog.cannotUndo')}
      </p>

      <div className="mt-6 flex justify-end gap-3">
        <Button variant="outline" onClick={onCancel}>
          {tc('cancel')}
        </Button>
        <Button variant="danger" onClick={handleConfirm} disabled={isLoading}>
          {tc('delete')}
        </Button>
      </div>
    </Modal>
  );
}
