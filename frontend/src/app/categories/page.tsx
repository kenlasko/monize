'use client';

import { useState, useEffect, useMemo } from 'react';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { CategoryForm } from '@/components/categories/CategoryForm';
import { CategoryList, DensityLevel } from '@/components/categories/CategoryList';
import { Modal } from '@/components/ui/Modal';
import { categoriesApi } from '@/lib/categories';
import { Category } from '@/types/category';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { SummaryCard, SummaryIcons } from '@/components/ui/SummaryCard';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { useFormModal } from '@/hooks/useFormModal';
import { createLogger } from '@/lib/logger';

const logger = createLogger('Categories');

export default function CategoriesPage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isImporting, setIsImporting] = useState(false);
  const [filterType, setFilterType] = useState<'all' | 'income' | 'expense'>('all');
  const [listDensity, setListDensity] = useLocalStorage<DensityLevel>('monize-categories-density', 'normal');
  const { showForm, editingItem, openCreate, openEdit, close, isEditing } = useFormModal<Category>();

  const loadCategories = async () => {
    setIsLoading(true);
    try {
      const data = await categoriesApi.getAll();
      setCategories(data);
    } catch (error) {
      toast.error('Failed to load categories');
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
      } else {
        await categoriesApi.create(cleanedData);
        toast.success('Category created successfully');
      }
      close();
      loadCategories();
    } catch (error: any) {
      const message = error.response?.data?.message || `Failed to ${editingItem ? 'update' : 'create'} category`;
      toast.error(message);
      throw error;
    }
  };

  const handleImportDefaults = async () => {
    setIsImporting(true);
    try {
      const result = await categoriesApi.importDefaults();
      toast.success(`Successfully imported ${result.categoriesCreated} categories`);
      loadCategories();
    } catch (error: any) {
      const message = error.response?.data?.message || 'Failed to import default categories';
      toast.error(message);
    } finally {
      setIsImporting(false);
    }
  };

  const filteredCategories = useMemo(() => {
    if (filterType === 'all') return categories;
    return categories.filter((c) => (filterType === 'income' ? c.isIncome : !c.isIncome));
  }, [categories, filterType]);

  const incomeCount = categories.filter((c) => c.isIncome).length;
  const expenseCount = categories.filter((c) => !c.isIncome).length;
  const topLevelCount = categories.filter((c) => !c.parentId).length;

  return (
    <PageLayout>
      <PageHeader
        title="Categories"
        subtitle="Organize your transactions with custom categories"
        actions={<Button onClick={openCreate}>+ New Category</Button>}
      />

      <div className="px-4 sm:px-6 lg:px-12 py-8">
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

        {/* Filter Tabs */}
        <div className="mb-6">
          <div className="border-b border-gray-200 dark:border-gray-700">
            <nav className="-mb-px flex space-x-8">
              <button
                onClick={() => setFilterType('all')}
                className={`${
                  filterType === 'all'
                    ? 'border-blue-500 text-blue-600 dark:text-blue-400'
                    : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
                } whitespace-nowrap py-2 px-1 border-b-2 font-medium text-sm`}
              >
                All ({categories.length})
              </button>
              <button
                onClick={() => setFilterType('expense')}
                className={`${
                  filterType === 'expense'
                    ? 'border-red-500 text-red-600 dark:text-red-400'
                    : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
                } whitespace-nowrap py-2 px-1 border-b-2 font-medium text-sm`}
              >
                Expense ({expenseCount})
              </button>
              <button
                onClick={() => setFilterType('income')}
                className={`${
                  filterType === 'income'
                    ? 'border-green-500 text-green-600 dark:text-green-400'
                    : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600'
                } whitespace-nowrap py-2 px-1 border-b-2 font-medium text-sm`}
              >
                Income ({incomeCount})
              </button>
            </nav>
          </div>
        </div>

        {/* Form Modal */}
        <Modal isOpen={showForm} onClose={close} maxWidth="lg" className="p-6">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
            {isEditing ? 'Edit Category' : 'New Category'}
          </h2>
          <CategoryForm
            category={editingItem}
            categories={categories}
            onSubmit={handleFormSubmit}
            onCancel={close}
          />
        </Modal>

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
              density={listDensity}
              onDensityChange={setListDensity}
            />
          )}
        </div>

        {/* Total count */}
        {filteredCategories.length > 0 && (
          <div className="mt-4 text-sm text-gray-500 dark:text-gray-400 text-center">
            {filteredCategories.length} categor{filteredCategories.length !== 1 ? 'ies' : 'y'}
          </div>
        )}
      </div>
    </PageLayout>
  );
}
