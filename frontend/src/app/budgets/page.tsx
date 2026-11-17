'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
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
import { useMobileAddAction } from '@/store/mobileAddActionStore';
import { useRetainScrollPosition } from '@/hooks/useRetainScrollPosition';
import { readPageSnapshot, writePageSnapshot } from '@/lib/page-snapshot';

/** What the list last drew, so a return draws it at once (`page-snapshot.ts`). */
const BUDGETS_SNAPSHOT_KEY = 'budgets';

export default function BudgetsPage() {
  return (
    <ProtectedRoute>
      <BudgetsContent />
    </ProtectedRoute>
  );
}

function BudgetsContent() {
  const t = useTranslations('budgets');
  // The list's last successful answer, read once: drawn at once on a return
  // while the mount load below replaces it with the current one.
  const [snapshot] = useState(() => readPageSnapshot<Budget[]>(BUDGETS_SNAPSHOT_KEY));
  const [budgets, setBudgets] = useState<Budget[]>(snapshot ?? []);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isLoading, setIsLoading] = useState(snapshot === undefined);
  const [showWizard, setShowWizard] = useState(false);
  const { defaultCurrency } = useExchangeRates();
  const router = useRouter();
  // The wizard is not the list, so it keeps no place of its own.
  useRetainScrollPosition(!isLoading && !showWizard);
  useMobileAddAction(t('pages.list.newBudget'), () => setShowWizard(true));

  // "Latest load started wins": a reload after a write supersedes one still in
  // flight, whose late answer must not overwrite the newer one.
  const loadSeq = useRef(0);

  // The mount load (the state already says loading), and the reload after a
  // write, which keeps the list on screen and swaps the new answer in.
  const fetchBudgets = useCallback(() => {
    // Writes live in `run` so they land after the request, not during the effect.
    const run = async () => {
      const seq = ++loadSeq.current;
      try {
        const data = await budgetsApi.getAll();
        if (seq !== loadSeq.current) return;
        setBudgets(data);
        writePageSnapshot<Budget[]>(BUDGETS_SNAPSHOT_KEY, data);
      } catch (error) {
        if (seq !== loadSeq.current) return;
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
        if (seq === loadSeq.current) setIsLoading(false);
      }
    };
    return run();
  }, [t]);

  useEffect(() => {
    fetchBudgets();
    accountsApi.getAll().then(setAccounts).catch(() => {});
  }, [fetchBudgets]);

  useOnUndoRedo(fetchBudgets);
  // Refresh on AI chat-bubble writes (budget spending can change).
  useOnAiAction(fetchBudgets);

  const handleWizardComplete = () => {
    setShowWizard(false);
    fetchBudgets();
  };

  if (showWizard) {
    return (
      <PageLayout>
        <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <PageHeader
            title={t('pages.create.title')}
            subtitle={t('pages.create.subtitle')}
            help="budgets"
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
          help='budgets'
          primaryAction={
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
