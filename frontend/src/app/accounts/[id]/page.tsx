'use client';

import { useState, useEffect, useCallback } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { LoanDetailView } from '@/components/accounts/loan-detail/LoanDetailView';
import { LineOfCreditView } from '@/components/accounts/loan-detail/LineOfCreditView';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import { accountsApi } from '@/lib/accounts';
import { loanScenariosApi } from '@/lib/loan-scenarios';
import { fetchAllAccountTransactions } from '@/lib/loan-history';
import { formatAccountType } from '@/lib/account-utils';
import { getErrorMessage } from '@/lib/errors';
import type { Account, AccountType } from '@/types/account';
import type { Transaction } from '@/types/transaction';
import type { LoanScenario } from '@/types/loan-scenario';

const DEBT_ACCOUNT_TYPES: AccountType[] = ['LOAN', 'MORTGAGE', 'LINE_OF_CREDIT'];

export default function AccountDetailPage() {
  return (
    <ProtectedRoute>
      <AccountDetailContent />
    </ProtectedRoute>
  );
}

function AccountDetailContent() {
  const t = useTranslations('accounts');
  const tc = useTranslations('common');
  const params = useParams();
  const router = useRouter();
  const accountId = params.id as string;

  const [account, setAccount] = useState<Account | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [scenarios, setScenarios] = useState<LoanScenario[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const isRevolving = account?.accountType === 'LINE_OF_CREDIT';
  const isDebtAccount = !account || DEBT_ACCOUNT_TYPES.includes(account.accountType);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const accountData = await accountsApi.getById(accountId);
      // A revolving line of credit uses the balance-history view, which loads
      // its own daily balances; only the amortizing view needs transactions.
      if (accountData.accountType === 'LINE_OF_CREDIT') {
        setAccount(accountData);
        setTransactions([]);
        setScenarios([]);
        return;
      }
      const [transactionsData, scenariosData] = await Promise.all([
        fetchAllAccountTransactions(accountId),
        loanScenariosApi.getAll(accountId).catch(() => [] as LoanScenario[]),
      ]);
      setAccount(accountData);
      setTransactions(transactionsData);
      setScenarios(scenariosData);
    } catch (err) {
      const message = getErrorMessage(err, t('loanDetail.loadFailed'));
      setError(message);
      toast.error(message);
    } finally {
      setIsLoading(false);
    }
  }, [accountId, t]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useOnUndoRedo(loadData);
  useOnAiAction(loadData);

  const reloadScenarios = useCallback(async () => {
    try {
      setScenarios(await loanScenariosApi.getAll(accountId));
    } catch {
      // The list stays as-is; individual actions already surfaced their error
    }
  }, [accountId]);

  // The detail view only exists for debt accounts; anything else lands on its
  // transaction register instead.
  useEffect(() => {
    if (account && !DEBT_ACCOUNT_TYPES.includes(account.accountType)) {
      router.replace(`/transactions?accountId=${account.id}`);
    }
  }, [account, router]);

  if (isLoading) {
    return (
      <PageLayout>
        <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <LoadingSpinner />
        </main>
      </PageLayout>
    );
  }

  if (error || !account) {
    return (
      <PageLayout>
        <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <div className="bg-white dark:bg-gray-800 shadow rounded-lg p-12 text-center">
            <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
              {error || t('loanDetail.notFound')}
            </h3>
            <Button onClick={() => router.push('/accounts')}>
              {t('loanDetail.backToAccounts')}
            </Button>
          </div>
        </main>
      </PageLayout>
    );
  }

  if (!isDebtAccount) {
    // Redirecting to the transaction register (see effect above)
    return (
      <PageLayout>
        <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <LoadingSpinner />
        </main>
      </PageLayout>
    );
  }

  return (
    <PageLayout>
      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title={account.name}
          subtitle={`${formatAccountType(account.accountType, tc)} - ${account.currencyCode}`}
          actions={
            <div className="flex items-center gap-3">
              <Button
                variant="outline"
                onClick={() => router.push(`/transactions?accountId=${account.id}`)}
              >
                {t('loanDetail.viewTransactions')}
              </Button>
              <Button variant="outline" onClick={() => router.push('/accounts')}>
                {t('loanDetail.backToAccounts')}
              </Button>
            </div>
          }
        />

        {isRevolving ? (
          <LineOfCreditView account={account} />
        ) : (
          <LoanDetailView
            account={account}
            transactions={transactions}
            scenarios={scenarios}
            onScenariosChanged={reloadScenarios}
          />
        )}
      </main>
    </PageLayout>
  );
}
