'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { BudgetForm } from '@/components/budgets/BudgetForm';
import { BudgetCategoryForm } from '@/components/budgets/BudgetCategoryForm';
import { BudgetProgressBar } from '@/components/budgets/BudgetProgressBar';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { budgetsApi } from '@/lib/budgets';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { getErrorMessage } from '@/lib/errors';
import type {
  Budget,
  BudgetCategory,
  BudgetSummary,
  UpdateBudgetData,
  UpdateBudgetCategoryData,
} from '@/types/budget';

export default function BudgetEditPage() {
  return (
    <ProtectedRoute>
      <BudgetEditContent />
    </ProtectedRoute>
  );
}

function BudgetEditContent() {
  const params = useParams();
  const router = useRouter();
  const { formatCurrency } = useNumberFormat();
  const budgetId = params.id as string;

  const [budget, setBudget] = useState<Budget | null>(null);
  const [summary, setSummary] = useState<BudgetSummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [editingCategory, setEditingCategory] = useState<BudgetCategory | null>(
    null,
  );

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [budgetData, summaryData] = await Promise.all([
        budgetsApi.getById(budgetId),
        budgetsApi.getSummary(budgetId),
      ]);
      setBudget(budgetData);
      setSummary(summaryData);
    } catch (err) {
      toast.error(getErrorMessage(err, 'Failed to load budget'));
      router.push('/budgets');
    } finally {
      setIsLoading(false);
    }
  }, [budgetId, router]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleSaveBudget = async (data: UpdateBudgetData) => {
    setIsSaving(true);
    try {
      await budgetsApi.update(budgetId, data);
      toast.success('Budget updated');
      loadData();
    } catch (err) {
      toast.error(getErrorMessage(err, 'Failed to update budget'));
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveCategory = async (data: UpdateBudgetCategoryData) => {
    if (!editingCategory) return;
    setIsSaving(true);
    try {
      await budgetsApi.updateCategory(budgetId, editingCategory.id, data);
      toast.success('Category updated');
      setEditingCategory(null);
      loadData();
    } catch (err) {
      toast.error(getErrorMessage(err, 'Failed to update category'));
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading || !budget) {
    return (
      <PageLayout>
        <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <LoadingSpinner />
        </main>
      </PageLayout>
    );
  }

  const expenseCategories = budget.categories.filter((c) => !c.isIncome);
  const incomeCategories = budget.categories.filter((c) => c.isIncome);

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title={`Edit: ${budget.name}`}
          subtitle="Update budget settings and category allocations"
          actions={
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                onClick={() => router.push(`/budgets/${budgetId}`)}
              >
                Back to Dashboard
              </Button>
            </div>
          }
        />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Budget Settings */}
          <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
              Budget Settings
            </h2>
            <BudgetForm
              budget={budget}
              onSave={handleSaveBudget}
              onCancel={() => router.push(`/budgets/${budgetId}`)}
              isSaving={isSaving}
            />
          </div>

          {/* Category List */}
          <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
              Category Allocations
            </h2>

            {incomeCategories.length > 0 && (
              <div className="mb-6">
                <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wider">
                  Income
                </h3>
                <div className="space-y-2">
                  {incomeCategories.map((cat) => (
                    <button
                      key={cat.id}
                      className="w-full text-left p-3 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors"
                      onClick={() => setEditingCategory(cat)}
                      type="button"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-gray-900 dark:text-gray-100">
                          {cat.category?.name ?? 'Unknown'}
                        </span>
                        <span className="text-sm text-green-600 dark:text-green-400">
                          {formatCurrency(cat.amount, budget.currencyCode)}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              </div>
            )}

            <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wider">
              Expenses ({expenseCategories.length})
            </h3>
            <div className="space-y-2">
              {expenseCategories.map((cat) => {
                const breakdownItem = summary?.categoryBreakdown.find(
                  (b) => b.budgetCategoryId === cat.id,
                );
                const percentUsed = breakdownItem?.percentUsed ?? 0;

                return (
                  <button
                    key={cat.id}
                    className="w-full text-left p-3 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors"
                    onClick={() => setEditingCategory(cat)}
                    type="button"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-900 dark:text-gray-100">
                          {cat.category?.name ?? 'Unknown'}
                        </span>
                        {cat.flexGroup && (
                          <span className="px-1.5 py-0.5 bg-purple-50 text-purple-600 dark:bg-purple-900/30 dark:text-purple-400 text-xs rounded font-medium">
                            {cat.flexGroup}
                          </span>
                        )}
                      </div>
                      <span className="text-sm text-gray-900 dark:text-gray-100">
                        {formatCurrency(cat.amount, budget.currencyCode)}
                      </span>
                    </div>
                    <BudgetProgressBar percentUsed={percentUsed} />
                    <div className="flex items-center justify-between mt-1 text-xs text-gray-500 dark:text-gray-400">
                      <span>
                        {cat.rolloverType !== 'NONE'
                          ? `Rollover: ${cat.rolloverType.toLowerCase()}`
                          : 'Resets each period'}
                      </span>
                      <span>{Math.round(percentUsed)}% used</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>

        {/* Category Edit Modal */}
        {editingCategory && (
          <Modal
            isOpen={true}
            onClose={() => setEditingCategory(null)}
            title={`Edit ${editingCategory.category?.name ?? 'Category'}`}
          >
            <BudgetCategoryForm
              category={editingCategory}
              onSave={handleSaveCategory}
              onCancel={() => setEditingCategory(null)}
              isSaving={isSaving}
            />
          </Modal>
        )}
      </main>
    </PageLayout>
  );
}
