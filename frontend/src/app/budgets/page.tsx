'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import { Button } from '@/components/ui/Button';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { BudgetWizard } from '@/components/budgets/BudgetWizard';
import { BudgetList } from '@/components/budgets/BudgetList';
import { CARD_CLASS } from '@/components/ui/Card';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { budgetsApi } from '@/lib/budgets';
import { accountsApi } from '@/lib/accounts';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { getErrorMessage } from '@/lib/errors';
import type { Budget } from '@/types/budget';
import type { Account } from '@/types/account';
import { docsUrl } from '@/lib/docs-links';

export default function BudgetsPage() {
  return (
    <ProtectedRoute>
      <BudgetsContent />
    </ProtectedRoute>
  );
}

function BudgetsContent() {
  const t = useTranslations('budgets');
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showWizard, setShowWizard] = useState(false);
  const { defaultCurrency } = useExchangeRates();
  const router = useRouter();

  // The mount load: the state already says loading.
  const fetchBudgets = useCallback(() => {
    // Writes live in `run` so they land after the request, not during the effect.
    const run = async () => {
      try {
        const data = await budgetsApi.getAll();
        setBudgets(data);
      } catch (error) {
        // A 403 here means a delegate hit /budgets without the section
        // grant; DelegateSectionGuard already shows the single, consistent
        // "no access" message and redirects, so don't double-toast.
        const status =
          typeof error === 'object' && error && 'response' in error
            ? (error as { response?: { status?: number } }).response?.status
            : undefined;
        if (status !== 403) {
          toast.error(getErrorMessage(error, t('pages.detail.toasts.loadFailed')));
        }
      } finally {
        setIsLoading(false);
      }
    };
    return run();
  }, [t]);

  const loadBudgets = useCallback(() => {
    setIsLoading(true);
    return fetchBudgets();
  }, [fetchBudgets]);

  useEffect(() => {
    fetchBudgets();
    accountsApi.getAll().then(setAccounts).catch(() => {});
  }, [fetchBudgets]);

  useOnUndoRedo(loadBudgets);
  // Refresh on AI chat-bubble writes (budget spending can change).
  useOnAiAction(loadBudgets);

  const handleWizardComplete = () => {
    setShowWizard(false);
    loadBudgets();
  };

  if (showWizard) {
    return (
      <PageLayout>
        <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <PageHeader
            title={t('pages.create.title')}
            subtitle={t('pages.create.subtitle')}
          />
          <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-6">
            <BudgetWizard
              onComplete={handleWizardComplete}
              onCancel={() => setShowWizard(false)}
              defaultCurrency={defaultCurrency}
              accounts={accounts}
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
          title={t('pages.list.title')}
          subtitle={t('pages.list.subtitle')}
          helpUrl={docsUrl('budgets')}
          actions={
            <Button onClick={() => setShowWizard(true)}>
              {t('pages.list.newBudget')}
            </Button>
          }
        />

        <div className={`${CARD_CLASS} overflow-hidden`}>
          {isLoading ? (
            <LoadingSpinner text={t('pages.list.loading')} />
          ) : (
            <BudgetList
              budgets={budgets}
              onOpen={(budget) => router.push(`/budgets/${budget.id}`)}
              onCreate={() => setShowWizard(true)}
            />
          )}
        </div>
      </main>
    </PageLayout>
  );
}
