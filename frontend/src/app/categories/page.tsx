'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import { useHighlightParam } from '@/hooks/useHighlightTarget';
import dynamic from 'next/dynamic';
import { Button } from '@/components/ui/Button';
const CategoryForm = dynamic(() => import('@/components/categories/CategoryForm').then(m => m.CategoryForm), { ssr: false });
import { ImportDefaultCategoriesDialog } from '@/components/categories/ImportDefaultCategoriesDialog';
import { CategoryList, type SortField, type SortDirection } from '@/components/categories/CategoryList';
import { Modal } from '@/components/ui/Modal';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { categoriesApi, type ImportDefaultsOptions } from '@/lib/categories';
import { Category } from '@/types/category';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { SummaryCard, SummaryIcons } from '@/components/ui/SummaryCard';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { CARD_CLASS } from '@/components/ui/Card';
import { SEGMENTED_TOOLBAR_GROUP_CLASS, toolbarSegmentClass } from '@/components/ui/segmented-control';
import { useFormModal } from '@/hooks/useFormModal';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { docsUrl } from '@/lib/docs-links';

const logger = createLogger('Categories');

export default function CategoriesPage() {
  return (
    <ProtectedRoute>
      <CategoriesContent />
    </ProtectedRoute>
  );
}

function CategoriesContent() {
  const t = useTranslations('categories');
  // Deep link to a specific category (e.g. a "View categories" link). The tree
  // renders all rows, so no page jump is needed -- the row flashes in place.
  const highlightId = useHighlightParam();
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [filterType, setFilterType] = useState<'all' | 'income' | 'expense'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useLocalStorage<SortField>('monize-categories-sort-field', 'name');
  const [sortDirection, setSortDirection] = useLocalStorage<SortDirection>('monize-categories-sort-dir', 'asc');
  const { showForm, editingItem, openCreate, openEdit, close, isEditing, modalProps, setFormDirty, unsavedChangesDialog, formSubmitRef } = useFormModal<Category>();

  // The mount load: the state already says loading.
  const fetchCategories = useCallback(() => {
    // Writes live in `run` so they land after the request, not during the effect.
    const run = async () => {
      try {
        const data = await categoriesApi.getAll();
        setCategories(data);
      } catch (error) {
        toast.error(getErrorMessage(error, t('toasts.loadFailed')));
        logger.error(error);
      } finally {
        setIsLoading(false);
      }
    };
    return run();
  }, [t]);

  const loadCategories = useCallback(() => {
    setIsLoading(true);
    return fetchCategories();
  }, [fetchCategories]);

  useEffect(() => {
    fetchCategories();
  }, [fetchCategories]);

  useOnUndoRedo(loadCategories);
  // Refresh on AI chat-bubble writes (category transaction counts can change).
  useOnAiAction(loadCategories);

  const refreshCategories = useCallback(async () => {
    try {
      const data = await categoriesApi.getAll();
      setCategories(data);
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.loadFailed')));
      logger.error(error);
    }
  }, [t]);

  const handleFormSubmit = async (data: any) => {
    try {
      const cleanedData = {
        ...data,
        parentId: data.parentId || null,
        description: data.description || null,
        icon: data.icon || null,
        color: data.color || null,
      };

      if (editingItem) {
        await categoriesApi.update(editingItem.id, cleanedData);
        toast.success(t('toasts.updated'));
        close();
        refreshCategories();
      } else {
        await categoriesApi.create(cleanedData);
        toast.success(t('toasts.created'));
        close();
        refreshCategories();
      }
    } catch (error) {
      toast.error(getErrorMessage(error, editingItem ? t('toasts.updateFailed') : t('toasts.createFailed')));
      throw error;
    }
  };

  const handleImportDefaults = async (options: ImportDefaultsOptions) => {
    setIsImporting(true);
    try {
      const result = await categoriesApi.importDefaults(options);
      toast.success(t('toasts.importSuccess', { count: result.categoriesCreated }));
      setShowImportDialog(false);
      loadCategories();
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.importFailed')));
    } finally {
      setIsImporting(false);
    }
  };

  const typeFilteredCategories = useMemo(() => {
    if (filterType === 'all') return categories;
    return categories.filter((c) => (filterType === 'income' ? c.isIncome : !c.isIncome));
  }, [categories, filterType]);

  const filteredCategories = useMemo(() => {
    if (!searchQuery) return typeFilteredCategories;
    const query = searchQuery.toLowerCase();
    // Match on any category whose own name matches. Then also include the
    // parent of any matched subcategory so the tree row renders, and include
    // every subcategory of a matched parent so the user can see the whole
    // branch they were searching for.
    const byId = new Map(typeFilteredCategories.map((c) => [c.id, c]));
    const matchedIds = new Set(
      typeFilteredCategories
        .filter((c) => c.name.toLowerCase().includes(query))
        .map((c) => c.id),
    );
    for (const id of Array.from(matchedIds)) {
      const cat = byId.get(id);
      if (cat?.parentId) matchedIds.add(cat.parentId);
    }
    for (const c of typeFilteredCategories) {
      if (c.parentId && matchedIds.has(c.parentId)) matchedIds.add(c.id);
    }
    return typeFilteredCategories.filter((c) => matchedIds.has(c.id));
  }, [typeFilteredCategories, searchQuery]);

  const handleSort = useCallback((field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection(field === 'count' ? 'desc' : 'asc');
    }
  }, [sortField, setSortField, setSortDirection]);

  const incomeCount = categories.filter((c) => c.isIncome).length;
  const expenseCount = categories.filter((c) => !c.isIncome).length;
  const topLevelCount = categories.filter((c) => !c.parentId).length;

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title={t('page.title')}
          subtitle={t('page.subtitle')}
          helpUrl={docsUrl('categories')}
          actions={<Button onClick={openCreate}>{t('page.newButton')}</Button>}
        />
        {/* Summary Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-6 mb-6">
          <SummaryCard
            label={t('page.summaryTotal')}
            value={categories.length}
            icon={SummaryIcons.tag}
          />
          <SummaryCard
            label={t('page.summaryIncome')}
            value={incomeCount}
            icon={SummaryIcons.plusCircle}
            valueColor="green"
          />
          <SummaryCard
            label={t('page.summaryExpense')}
            value={expenseCount}
            icon={SummaryIcons.minus}
            valueColor="red"
          />
          <SummaryCard
            label={t('page.summaryTopLevel')}
            value={topLevelCount}
            icon={SummaryIcons.list}
            valueColor="blue"
          />
        </div>

        {/* Search and Filter */}
        <div className="mb-6 flex flex-wrap items-center gap-4">
          <input
            type="text"
            placeholder={t('page.searchPlaceholder')}
            aria-label={t('page.searchPlaceholder')}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="block w-full sm:w-auto sm:flex-1 sm:max-w-md rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-400 dark:focus:border-blue-400 dark:focus:ring-blue-400"
          />
          <div role="group" aria-label={t('page.typeFilterLabel')} className={SEGMENTED_TOOLBAR_GROUP_CLASS}>
            {(['all', 'expense', 'income'] as const).map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => setFilterType(type)}
                aria-pressed={filterType === type}
                className={toolbarSegmentClass(filterType === type)}
              >
                {type === 'all' ? t('page.filterAll', { count: categories.length }) :
                 type === 'expense' ? t('page.filterExpenses', { count: expenseCount }) :
                 t('page.filterIncome', { count: incomeCount })}
              </button>
            ))}
          </div>
        </div>

        {/* Form Modal */}
        <Modal isOpen={showForm} onClose={close} {...modalProps} maxWidth="lg" className="p-6">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
            {isEditing ? t('page.modalTitleEdit') : t('page.modalTitleNew')}
          </h2>
          <CategoryForm
            category={editingItem}
            categories={categories}
            onSubmit={handleFormSubmit}
            onCancel={close}
            onDirtyChange={setFormDirty}
            submitRef={formSubmitRef}
          />
        </Modal>
        <UnsavedChangesDialog {...unsavedChangesDialog} />

        {/* Default category import (country + language) */}
        <ImportDefaultCategoriesDialog
          isOpen={showImportDialog}
          isImporting={isImporting}
          onClose={() => setShowImportDialog(false)}
          onConfirm={handleImportDefaults}
        />

        {/* Categories List */}
        <div className={`${CARD_CLASS} overflow-hidden`}>
          {isLoading ? (
            <LoadingSpinner text={t('page.loadingText')} />
          ) : (
            <CategoryList
              categories={filteredCategories}
              isFiltered={categories.length > 0}
              onCreate={openCreate}
              onImportDefaults={() => setShowImportDialog(true)}
              isImporting={isImporting}
              onEdit={openEdit}
              onRefresh={refreshCategories}
              onDelete={(deletedId) => setCategories(prev => prev.filter(c => c.id !== deletedId && c.parentId !== deletedId))}
              sortField={sortField}
              sortDirection={sortDirection}
              onSort={handleSort}
              highlightId={highlightId}
            />
          )}
        </div>

        {/* Total count */}
        {filteredCategories.length > 0 && (
          <div className="mt-4 text-sm text-gray-500 dark:text-gray-400 text-center">
            {filteredCategories.length !== 1 ? t('page.countPlural', { count: filteredCategories.length }) : t('page.countSingle')}
          </div>
        )}
      </main>
    </PageLayout>
  );
}
