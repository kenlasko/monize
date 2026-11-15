'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
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
import { TransferIncomeLineForm } from '@/components/budgets/TransferIncomeLineForm';
import { budgetLineName } from '@/components/budgets/utils/budget-line-name';
import { Button } from '@/components/ui/Button';
import { accountsApi } from '@/lib/accounts';
import type { Account } from '@/types/account';
import { BudgetBucketEditor } from '@/components/budgets/BudgetBucketEditor';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { budgetsApi } from '@/lib/budgets';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { getErrorMessage } from '@/lib/errors';
import type {
  Budget,
  BudgetCategory,
  CreateBudgetBucketData,
  UpdateBudgetBucketData,
  BudgetSummary,
  UpdateBudgetData,
  UpdateBudgetCategoryData,
  CreateTransferIncomeLineData,
} from '@/types/budget';


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
  const [addingTransferIncome, setAddingTransferIncome] = useState(false);
  // `null` until loaded or when the load failed: the add dialog is not offered
  // on a list that never arrived.
  const [accounts, setAccounts] = useState<Account[] | null>(null);

  const getCategoryDisplayName = (cat: BudgetCategory): string =>
    budgetLineName(cat, {
      transfersFrom: (name) => t('lineNames.transfersFrom', { name }),
      unknown: t('lineNames.unknown'),
    });

  // A different budget shows the spinner again; set during render rather than
  // in the effect that loads it.
  const [loadingBudgetId, setLoadingBudgetId] = useState(budgetId);
  if (loadingBudgetId !== budgetId) {
    setLoadingBudgetId(budgetId);
    setIsLoading(true);
  }

  // Each read of the budget takes a number; only the newest one may land, so a
  // slow refresh never overwrites the answer to a later one.
  const readSeq = useRef(0);

  // The mount / budget-switch load: the state already says loading.
  const fetchData = useCallback(() => {
    const seq = ++readSeq.current;
    // Writes live in `run` so they land after the request, not during the effect.
    const run = async () => {
      try {
        const [budgetData, summaryData] = await Promise.all([
          budgetsApi.getById(budgetId),
          budgetsApi.getSummary(budgetId),
        ]);
        if (seq !== readSeq.current) return;
        setBudget(budgetData);
        setSummary(summaryData);
      } catch (err) {
        if (seq !== readSeq.current) return;
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

  useEffect(() => {
    accountsApi.getAll().then(setAccounts).catch(() => setAccounts(null));
  }, []);
  // After a bucket write: re-read in place, keeping the page (and the editor) mounted,
  // so the category list and the line form see the new buckets.
  const refreshBudget = useCallback(async () => {
    const seq = ++readSeq.current;
    try {
      const [budgetData, summaryData] = await Promise.all([
        budgetsApi.getById(budgetId),
        budgetsApi.getSummary(budgetId),
      ]);
      if (seq !== readSeq.current) return;
      setBudget(budgetData);
      setSummary(summaryData);
    } catch (err) {
      if (seq !== readSeq.current) return;
      toast.error(getErrorMessage(err, t('pages.edit.toasts.loadFailed')));
    }
  }, [budgetId, t]);

  const handleCreateBucket = useCallback(
    (data: CreateBudgetBucketData) => budgetsApi.createBucket(budgetId, data),
    [budgetId],
  );
  const handleUpdateBucket = useCallback(
    (bucketId: string, data: UpdateBudgetBucketData) => budgetsApi.updateBucket(budgetId, bucketId, data),
    [budgetId],
  );
  const handleDeleteBucket = useCallback(
    (bucketId: string) => budgetsApi.deleteBucket(budgetId, bucketId),
    [budgetId],
  );

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

  const handleAddTransferIncome = async (data: CreateTransferIncomeLineData) => {
    setIsSaving(true);
    try {
      await budgetsApi.addTransferIncomeLine(budgetId, data);
      toast.success(t('pages.edit.toasts.transferIncomeAdded'));
      setAddingTransferIncome(false);
      loadData();
    } catch (err) {
      toast.error(getErrorMessage(err, t('pages.edit.toasts.transferIncomeFailed')));
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
  // One transfer line per account: an account already named is not offered.
  const namedTransferAccounts = new Set(
    budget.categories
      .filter((c) => c.isTransfer && c.transferAccountId)
      .map((c) => c.transferAccountId),
  );
  const transferIncomeAccounts = (accounts ?? []).filter(
    (a) => !a.isClosed && a.userId === budget.userId && !namedTransferAccounts.has(a.id),
  );
  const transfersInAsIncome = budget.config?.transfersInAsIncome === true;
  // The saved strategy decides, so the section appears once a strategy change is saved.
  const isBucketBudget = budget.strategy === 'BUCKET';
  const buckets = budget.buckets ?? [];
  const bucketNames = new Map(buckets.map((bucket) => [bucket.id, bucket.name]));

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
          <div className="space-y-6">
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

            {isBucketBudget && (
              <Card as="section" padding="md" aria-labelledby="budget-buckets-heading">
                <h2
                  id="budget-buckets-heading"
                  className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4"
                >
                  {t('pages.edit.buckets')}
                </h2>
                <BudgetBucketEditor
                  mode="persisted"
                  currencyCode={budget.currencyCode}
                  buckets={buckets}
                  onCreate={handleCreateBucket}
                  onUpdate={handleUpdateBucket}
                  onDelete={handleDeleteBucket}
                  onWritten={refreshBudget}
                />
              </Card>
            )}
          </div>

          {/* Category List */}
          <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
              {t('pages.edit.categoryAllocations')}
            </h2>

            <div className="mb-6">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  {t('pages.edit.income')}
                </h3>
                {accounts !== null && transferIncomeAccounts.length > 0 && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setAddingTransferIncome(true)}
                  >
                    {t('pages.edit.addTransferIncome')}
                  </Button>
                )}
              </div>
              {(incomeCategories.length > 0 || transfersInAsIncome) && (
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
                  {transfersInAsIncome && (
                    <div className="p-3 border border-dashed border-gray-200 dark:border-gray-700 rounded-lg">
                      <div className="flex items-center justify-between">
                        <span className="font-medium text-gray-900 dark:text-gray-100">
                          {t('pages.edit.outsideTransferIncome')}
                        </span>
                        {summary && (
                          <span className="text-sm text-green-600 dark:text-green-400">
                            {formatCurrency(summary.outsideTransferIncome, budget.currencyCode)}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                        {t('pages.edit.outsideTransferIncomeHint')}
                      </p>
                    </div>
                  )}
                </div>
              )}
            </div>

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
                        {isBucketBudget && (
                          <Badge variant={cat.bucketId ? 'blue' : 'gray'}>
                            {(cat.bucketId && bucketNames.get(cat.bucketId)) || t('pages.edit.unassignedBucket')}
                          </Badge>
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
              strategy={budget.strategy}
              buckets={buckets}
            />
          </Modal>
        )}

        {addingTransferIncome && (
          <Modal
            isOpen={true}
            onClose={() => setAddingTransferIncome(false)}
            title={t('pages.edit.addTransferIncomeTitle')}
            className="p-6"
          >
            <TransferIncomeLineForm
              accounts={transferIncomeAccounts}
              currencyCode={budget.currencyCode}
              onSave={handleAddTransferIncome}
              onCancel={() => setAddingTransferIncome(false)}
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
