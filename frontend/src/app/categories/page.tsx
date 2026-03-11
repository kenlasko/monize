'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import toast from 'react-hot-toast';
import dynamic from 'next/dynamic';
import { Button } from '@/components/ui/Button';
const CategoryForm = dynamic(() => import('@/components/categories/CategoryForm').then(m => m.CategoryForm), { ssr: false });
import { CategoryList, type DensityLevel, type SortField, type SortDirection } from '@/components/categories/CategoryList';
import { Modal } from '@/components/ui/Modal';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { categoriesApi } from '@/lib/categories';
import { Category } from '@/types/category';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { SummaryCard, SummaryIcons } from '@/components/ui/SummaryCard';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useFormModal } from '@/hooks/useFormModal';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';

const logger = createLogger('Categories');

export default function CategoriesPage() {
  return (
    <ProtectedRoute>
      <CategoriesContent />
    </ProtectedRoute>
  );
}

function CategoriesContent() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const [filterType, setFilterType] = useState<'all' | 'income' | 'expense'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [listDensity, setListDensity] = useLocalStorage<DensityLevel>('monize-categories-density', 'normal');
  const [sortField, setSortField] = useLocalStorage<SortField>('monize-categories-sort-field', 'name');
  const [sortDirection, setSortDirection] = useLocalStorage<SortDirection>('monize-categories-sort-dir', 'asc');
  const { showForm, editingItem, openCreate, openEdit, close, isEditing, modalProps, setFormDirty, unsavedChangesDialog, formSubmitRef } = useFormModal<Category>();

  const loadCategories = async () => {
    setIsLoading(true);
    try {
      const data = await categoriesApi.getAll();
      setCategories(data);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to load categories'));
      logger.error(error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadCategories();
  }, []);

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
        toast.success('Category updated successfully');
        close();
        loadCategories();
      } else {
        await categoriesApi.create(cleanedData);
        toast.success('Category created successfully');
        close();
        loadCategories();
      }
    } catch (error) {
      toast.error(getErrorMessage(error, `Failed to ${editingItem ? 'update' : 'create'} category`));
      throw error;
    }
  };

  const handleImportDefaults = async () => {
    setIsImporting(true);
    try {
      const result = await categoriesApi.importDefaults();
      toast.success(`Successfully imported ${result.categoriesCreated} categories`);
      loadCategories();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to import default categories'));
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
    return typeFilteredCategories.filter((c) =>
      c.name.toLowerCase().includes(searchQuery.toLowerCase())
    );
  }, [typeFilteredCategories, searchQuery]);

  const handleSort = useCallback((field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection(field === 'count' ? 'desc' : 'asc');
    }
  }, [sortField]);

  const incomeCount = categories.filter((c) => c.isIncome).length;
  const expenseCount = categories.filter((c) => !c.isIncome).length;
  const topLevelCount = categories.filter((c) => !c.parentId).length;

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title="Categories"
          subtitle="Organize your transactions with custom categories"
          helpUrl="https://github.com/kenlasko/monize/wiki/Categories-and-Payees"
          actions={<Button onClick={openCreate}>+ New Category</Button>}
        />
        {/* Summary Cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-6 mb-6">
          <SummaryCard
            label="Total Categories"
            value={categories.length}
            icon={SummaryIcons.tag}
          />
          <SummaryCard
            label="Income Categories"
            value={incomeCount}
            icon={SummaryIcons.plusCircle}
            valueColor="green"
          />
          <SummaryCard
            label="Expense Categories"
            value={expenseCount}
            icon={SummaryIcons.minus}
            valueColor="red"
          />
          <SummaryCard
            label="Top-Level"
            value={topLevelCount}
            icon={SummaryIcons.list}
            valueColor="blue"
          />
        </div>

        {/* Search and Filter */}
        <div className="mb-6 flex flex-col sm:flex-row gap-4">
          <input
            type="text"
            placeholder="Search categories..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="block w-full sm:max-w-md rounded-md border-gray-300 dark:border-gray-600 shadow-sm focus:border-blue-500 focus:ring-blue-500 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-400 dark:focus:border-blue-400 dark:focus:ring-blue-400"
          />
          <div className="flex rounded-md shadow-sm">
            {(['all', 'expense', 'income'] as const).map((status) => (
              <button
                key={status}
                onClick={() => setFilterType(status)}
                className={`px-4 py-2 text-sm font-medium border ${
                  filterType === status
                    ? 'bg-blue-600 text-white border-blue-600 dark:bg-blue-500 dark:border-blue-500'
                    : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-700'
                } ${
                  status === 'all' ? 'rounded-l-md' : ''
                } ${
                  status === 'income' ? 'rounded-r-md' : ''
                } ${
                  status !== 'all' ? '-ml-px' : ''
                }`}
              >
                {status === 'all' ? `All (${categories.length})` :
                 status === 'expense' ? `Expenses (${expenseCount})` :
                 `Income (${incomeCount})`}
              </button>
            ))}
          </div>
        </div>

        {/* Form Modal */}
        <Modal isOpen={showForm} onClose={close} {...modalProps} maxWidth="lg" className="p-6">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
            {isEditing ? 'Edit Category' : 'New Category'}
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

        {/* Categories List */}
        <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg overflow-hidden">
          {isLoading ? (
            <LoadingSpinner text="Loading categories..." />
          ) : categories.length === 0 ? (
            <div className="p-12 text-center">
              <svg
                className="mx-auto h-16 w-16 text-gray-400 dark:text-gray-500"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={1.5}
                  d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z"
                />
              </svg>
              <h3 className="mt-4 text-lg font-medium text-gray-900 dark:text-gray-100">
                No categories yet
              </h3>
              <p className="mt-2 text-sm text-gray-500 dark:text-gray-400 max-w-md mx-auto">
                Categories help you organize your transactions. Get started by importing our default
                set of categories, or create your own from scratch.
              </p>
              <div className="mt-6 flex flex-col sm:flex-row justify-center gap-3">
                <Button
                  onClick={handleImportDefaults}
                  isLoading={isImporting}
                  disabled={isImporting}
                >
                  Import Default Categories
                </Button>
                <Button
                  variant="outline"
                  onClick={openCreate}
                  disabled={isImporting}
                >
                  Create Your Own
                </Button>
              </div>
              <p className="mt-4 text-xs text-gray-400 dark:text-gray-500">
                The default set includes common income and expense categories with subcategories
              </p>
            </div>
          ) : (
            <CategoryList
              categories={filteredCategories}
              onEdit={openEdit}
              onRefresh={loadCategories}
              onDelete={(deletedId) => setCategories(prev => prev.filter(c => c.id !== deletedId && c.parentId !== deletedId))}
              density={listDensity}
              onDensityChange={setListDensity}
              sortField={sortField}
              sortDirection={sortDirection}
              onSort={handleSort}
            />
          )}
        </div>

        {/* Total count */}
        {filteredCategories.length > 0 && (
          <div className="mt-4 text-sm text-gray-500 dark:text-gray-400 text-center">
            {filteredCategories.length} categor{filteredCategories.length !== 1 ? 'ies' : 'y'}
          </div>
        )}
      </main>
    </PageLayout>
  );
}
