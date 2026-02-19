'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { BudgetWizard } from '@/components/budgets/BudgetWizard';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { budgetsApi } from '@/lib/budgets';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { getErrorMessage } from '@/lib/errors';
import type { Budget } from '@/types/budget';

export default function BudgetsPage() {
  return (
    <ProtectedRoute>
      <BudgetsContent />
    </ProtectedRoute>
  );
}

function BudgetsContent() {
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showWizard, setShowWizard] = useState(false);
  const { defaultCurrency } = useExchangeRates();
  const router = useRouter();

  const loadBudgets = async () => {
    setIsLoading(true);
    try {
      const data = await budgetsApi.getAll();
      setBudgets(data);
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to load budgets'));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadBudgets();
  }, []);

  const handleWizardComplete = () => {
    setShowWizard(false);
    loadBudgets();
  };

  const handleDelete = async (id: string) => {
    try {
      await budgetsApi.delete(id);
      toast.success('Budget deleted');
      loadBudgets();
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to delete budget'));
    }
  };

  if (showWizard) {
    return (
      <PageLayout>
        <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <PageHeader
            title="Create Budget"
            subtitle="Analyze your spending and create a personalized budget"
          />
          <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6">
            <BudgetWizard
              onComplete={handleWizardComplete}
              onCancel={() => setShowWizard(false)}
              defaultCurrency={defaultCurrency}
            />
          </div>
        </main>
      </PageLayout>
    );
  }

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title="Budgets"
          subtitle="Manage your budgets and track spending"
          actions={
            <Button onClick={() => setShowWizard(true)}>
              + New Budget
            </Button>
          }
        />

        {isLoading ? (
          <LoadingSpinner />
        ) : budgets.length === 0 ? (
          <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-12 text-center">
            <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
              No budgets yet
            </h3>
            <p className="text-gray-500 dark:text-gray-400 mb-6">
              Create your first budget by analyzing your spending history. The
              wizard will suggest realistic amounts based on your transactions.
            </p>
            <Button onClick={() => setShowWizard(true)}>
              Create Your First Budget
            </Button>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {budgets.map((budget) => (
              <div
                key={budget.id}
                className="bg-white dark:bg-gray-800 shadow rounded-lg p-6 hover:shadow-md transition-shadow"
              >
                <div className="flex items-start justify-between mb-4">
                  <div>
                    <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                      {budget.name}
                    </h3>
                    <p className="text-sm text-gray-500 dark:text-gray-400">
                      {budget.strategy} - {budget.budgetType}
                    </p>
                  </div>
                  <span
                    className={`px-2 py-1 rounded-full text-xs font-medium ${
                      budget.isActive
                        ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                        : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                    }`}
                  >
                    {budget.isActive ? 'Active' : 'Inactive'}
                  </span>
                </div>
                <div className="text-sm text-gray-600 dark:text-gray-300 mb-4">
                  <div>
                    {budget.categories?.length ?? 0} categories
                  </div>
                  <div>Started {budget.periodStart}</div>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => router.push(`/budgets/${budget.id}`)}
                  >
                    View
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleDelete(budget.id)}
                  >
                    Delete
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </PageLayout>
  );
}
