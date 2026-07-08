'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { LoanSummaryCards } from '@/components/accounts/loan-detail/LoanSummaryCards';
import { AmortizationScheduleTable } from '@/components/accounts/loan-detail/AmortizationScheduleTable';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import { accountsApi } from '@/lib/accounts';
import { deriveLoanPaymentHistory, fetchAllAccountTransactions } from '@/lib/loan-history';
import {
  ScheduleFrequency,
  advanceDate,
  generateLoanSchedule,
} from '@/lib/loan-schedule';
import { formatAccountType } from '@/lib/account-utils';
import { getErrorMessage } from '@/lib/errors';
import type { Account, AccountType } from '@/types/account';
import type { Transaction } from '@/types/transaction';

const LOAN_ACCOUNT_TYPES: AccountType[] = ['LOAN', 'MORTGAGE', 'LINE_OF_CREDIT'];

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
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [accountData, transactionsData] = await Promise.all([
        accountsApi.getById(accountId),
        fetchAllAccountTransactions(accountId),
      ]);
      setAccount(accountData);
      setTransactions(transactionsData);
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

  const isLoanAccount = !account || LOAN_ACCOUNT_TYPES.includes(account.accountType);

  // The detail view only exists for debt accounts; anything else lands on its
  // transaction register instead.
  useEffect(() => {
    if (account && !LOAN_ACCOUNT_TYPES.includes(account.accountType)) {
      router.replace(`/transactions?accountId=${account.id}`);
    }
  }, [account, router]);

  const history = useMemo(
    () => (account && isLoanAccount ? deriveLoanPaymentHistory(account, transactions) : null),
    [account, transactions, isLoanAccount],
  );

  const baseline = useMemo(() => {
    if (!account || !history) return null;
    const canProject =
      history.currentBalance > 0.01 &&
      account.interestRate != null &&
      account.paymentAmount &&
      account.paymentAmount > 0 &&
      account.paymentFrequency;
    if (!canProject) return null;

    const frequency = account.paymentFrequency as ScheduleFrequency;
    return generateLoanSchedule({
      startingBalance: history.currentBalance,
      annualRate: account.interestRate!,
      paymentAmount: account.paymentAmount!,
      frequency,
      isCanadian: account.isCanadianMortgage || false,
      isVariableRate: account.isVariableRate || false,
      firstPaymentDate: advanceDate(new Date(), frequency),
    });
  }, [account, history]);

  if (isLoading) {
    return (
      <PageLayout>
        <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
          <LoadingSpinner />
        </main>
      </PageLayout>
    );
  }

  if (error || !account || !history) {
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

  if (!isLoanAccount) {
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

        <div className="space-y-6">
          <LoanSummaryCards
            account={account}
            startingBalance={history.startingBalance}
            baseline={baseline}
          />

          <AmortizationScheduleTable
            historyEvents={history.events}
            projectionRows={baseline?.rows ?? []}
            currencyCode={account.currencyCode}
          />
        </div>
      </main>
    </PageLayout>
  );
}
