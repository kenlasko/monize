'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { BudgetForm } from '@/components/budgets/BudgetForm';
import { BudgetCategoryForm } from '@/components/budgets/BudgetCategoryForm';
import { BudgetProgressBar } from '@/components/budgets/BudgetProgressBar';
import { BudgetBackLink } from '@/components/budgets/BudgetBackLink';
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

function getCategoryDisplayName(cat: BudgetCategory): string {
  if (!cat.category) return 'Unknown';
  const { name, parent } = cat.category;
  return parent ? `${parent.name}: ${name}` : name;
}

export default function BudgetEditPage() {
  return (
    <ProtectedRoute>
      <BudgetEditContent />
    </ProtectedRoute>
  );
}

function BudgetEditContent() {
  const t = useTranslations('budgets');
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
  const [removingCategory, setRemovingCategory] = useState<BudgetCategory | null>(
    null,
  );

  // A different budget shows the spinner again; set during render rather than
  // in the effect that loads it.
  const [loadingBudgetId, setLoadingBudgetId] = useState(budgetId);
  if (loadingBudgetId !== budgetId) {
    setLoadingBudgetId(budgetId);
    setIsLoading(true);
  }

  // The mount / budget-switch load: the state already says loading.
  const fetchData = useCallback(() => {
    // Writes live in `run` so they land after the request, not during the effect.
    const run = async () => {
      try {
        const [budgetData, summaryData] = await Promise.all([
          budgetsApi.getById(budgetId),
          budgetsApi.getSummary(budgetId),
        ]);
        setBudget(budgetData);
        setSummary(summaryData);
      } catch (err) {
        toast.error(getErrorMessage(err, t('pages.edit.toasts.loadFailed')));
        router.push('/budgets');
      } finally {
        setIsLoading(false);
      }
    };
    return run();
  }, [budgetId, router, t]);

  const loadData = useCallback(() => {
    setIsLoading(true);
    return fetchData();
  }, [fetchData]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const handleSaveBudget = async (data: UpdateBudgetData) => {
    setIsSaving(true);
    try {
      await budgetsApi.update(budgetId, data);
      toast.success(t('pages.edit.toasts.updated'));
      loadData();
    } catch (err) {
      toast.error(getErrorMessage(err, t('pages.edit.toasts.updateFailed')));
    } finally {
      setIsSaving(false);
    }
  };

  const handleSaveCategory = async (data: UpdateBudgetCategoryData) => {
    if (!editingCategory) return;
    setIsSaving(true);
    try {
      await budgetsApi.updateCategory(budgetId, editingCategory.id, data);
      toast.success(t('pages.edit.toasts.categoryUpdated'));
      setEditingCategory(null);
      loadData();
    } catch (err) {
      toast.error(getErrorMessage(err, t('pages.edit.toasts.categoryFailed')));
    } finally {
      setIsSaving(false);
    }
  };

  const handleRemoveCategory = async () => {
    if (!removingCategory) return;
    const target = removingCategory;
    setRemovingCategory(null);
    setIsSaving(true);
    try {
      await budgetsApi.removeCategory(budgetId, target.id);
      toast.success(t('pages.edit.toasts.categoryRemoved'));
      loadData();
    } catch (err) {
      toast.error(getErrorMessage(err, t('pages.edit.toasts.categoryRemoveFailed')));
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
        <BudgetBackLink
          href={`/budgets/${budgetId}`}
          label={t('pages.edit.backToBudget', { name: budget.name })}
        />
        <PageHeader
          title={`${t('pages.edit.subtitlePrefix')}${budget.name}`}
          subtitle={t('pages.edit.subtitle')}
          help="budgets"
        />

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Budget Settings */}
          <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
              {t('pages.edit.budgetSettings')}
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
              {t('pages.edit.categoryAllocations')}
            </h2>

            {incomeCategories.length > 0 && (
              <div className="mb-6">
                <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-2 uppercase tracking-wider">
                  {t('pages.edit.income')}
                </h3>
                <div className="space-y-2">
                  {incomeCategories.map((cat) => (
                    <button
                      key={cat.id}
                      className="w-full text-left p-3 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                      onClick={() => setEditingCategory(cat)}
                      type="button"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-gray-900 dark:text-gray-100">
                          {getCategoryDisplayName(cat)}
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
              {t('pages.edit.expensesWithCount', { count: expenseCategories.length })}
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
                    className="w-full text-left p-3 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors"
                    onClick={() => setEditingCategory(cat)}
                    type="button"
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-900 dark:text-gray-100">
                          {getCategoryDisplayName(cat)}
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
                          ? t('pages.edit.rolloverType', { type: cat.rolloverType.toLowerCase() })
                          : t('pages.edit.resetsEachPeriod')}
                      </span>
                      <span>{t('pages.edit.percentUsed', { percent: String(Math.round(percentUsed)) })}</span>
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
            className="p-6"
          >
            <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
              {t('pages.edit.editCategoryTitle', { name: getCategoryDisplayName(editingCategory) })}
            </h2>
            <BudgetCategoryForm
              category={editingCategory}
              currencyCode={budget.currencyCode}
              onSave={handleSaveCategory}
              onCancel={() => setEditingCategory(null)}
              onRemove={() => {
                setRemovingCategory(editingCategory);
                setEditingCategory(null);
              }}
              isSaving={isSaving}
            />
          </Modal>
        )}

        {removingCategory && (
          <ConfirmDialog
            isOpen={true}
            title={t('pages.edit.remove.title')}
            message={t('pages.edit.remove.message', {
              name: getCategoryDisplayName(removingCategory),
              amount: formatCurrency(removingCategory.amount, budget.currencyCode),
            })}
            confirmLabel={t('pages.edit.remove.confirm')}
            variant="danger"
            onConfirm={handleRemoveCategory}
            onCancel={() => setRemovingCategory(null)}
          />
        )}
      </main>
    </PageLayout>
  );
}
