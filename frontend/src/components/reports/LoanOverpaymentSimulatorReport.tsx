'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { accountsApi } from '@/lib/accounts';
import { loanScenariosApi } from '@/lib/loan-scenarios';
import { loanRateChangesApi } from '@/lib/loan-rate-changes';
import { fetchAllAccountTransactions } from '@/lib/loan-history';
import { useReportData } from '@/hooks/useReportData';
import { ReportError } from '@/components/reports/ReportError';
import { LoanDetailView } from '@/components/accounts/loan-detail/LoanDetailView';
import { LineOfCreditView } from '@/components/accounts/loan-detail/LineOfCreditView';
import type { AccountType } from '@/types/account';
import type { Transaction } from '@/types/transaction';
import type { LoanScenario } from '@/types/loan-scenario';
import type { LoanRateChange } from '@/types/loan-rate-change';

const DEBT_ACCOUNT_TYPES: AccountType[] = ['LOAN', 'MORTGAGE', 'LINE_OF_CREDIT'];

/**
 * Reports-section entry point for the loan overpayment simulator. Owns an
 * account selector and reuses the same detail views as the /accounts/[id]
 * page: the amortizing simulator for loans/mortgages, the balance-history
 * view for a revolving line of credit.
 */
export function LoanOverpaymentSimulatorReport() {
  const t = useTranslations('reports');
  const router = useRouter();
  const [selectedAccountIdState, setSelectedAccountId] = useState<string>('');

  const {
    data: accountsData,
    isLoading: accountsLoading,
    error: accountsError,
    reload: reloadAccounts,
  } = useReportData(
    () =>
      accountsApi
        .getAll(true)
        .then((all) => all.filter((a) => DEBT_ACCOUNT_TYPES.includes(a.accountType))),
    [],
  );

  const accounts = useMemo(() => accountsData ?? [], [accountsData]);
  const selectedAccountId = selectedAccountIdState || accounts[0]?.id || '';
  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);
  const isRevolving = selectedAccount?.accountType === 'LINE_OF_CREDIT';

  const {
    data: accountData,
    isLoading: dataLoading,
    error: dataError,
    reload: reloadAccountData,
  } = useReportData(
    async () => {
      if (!selectedAccountId || isRevolving) {
        return {
          transactions: [] as Transaction[],
          scenarios: [] as LoanScenario[],
          rateChanges: [] as LoanRateChange[],
        };
      }
      const [transactions, scenarios, rateChanges] = await Promise.all([
        fetchAllAccountTransactions(selectedAccountId),
        loanScenariosApi.getAll(selectedAccountId).catch(() => [] as LoanScenario[]),
        loanRateChangesApi.getAll(selectedAccountId).catch(() => [] as LoanRateChange[]),
      ]);
      return { transactions, scenarios, rateChanges };
    },
    [selectedAccountId, isRevolving],
  );

  const transactions = accountData?.transactions ?? [];
  const scenarios = accountData?.scenarios ?? [];
  const rateChanges = accountData?.rateChanges ?? [];

  const error = accountsError || dataError;
  const reload = () => {
    reloadAccounts();
    reloadAccountData();
  };

  if (error) {
    return <ReportError onRetry={reload} />;
  }

  if (accountsLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <div className="space-y-4">
          <Skeleton className="h-8 w-1/3" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <p className="text-gray-500 dark:text-gray-400 text-center py-8">
          {t('loanOverpayment.empty')}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('loanOverpayment.labelSelectAccount')}
            </label>
            <select
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              className="rounded-md border-gray-300 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100 min-w-[200px]"
            >
              {accounts
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((account) => (
                  <option key={account.id} value={account.id}>
                    {account.name}
                  </option>
                ))}
            </select>
          </div>
          {selectedAccount && (
            <Button
              variant="outline"
              onClick={() => router.push(`/transactions?accountId=${selectedAccount.id}`)}
            >
              {t('loanOverpayment.viewTransactions')}
            </Button>
          )}
        </div>
      </div>

      {selectedAccount && isRevolving && <LineOfCreditView account={selectedAccount} />}

      {selectedAccount && !isRevolving && dataLoading && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {selectedAccount && !isRevolving && !dataLoading && (
        <LoanDetailView
          account={selectedAccount}
          transactions={transactions}
          scenarios={scenarios}
          rateChanges={rateChanges}
          onScenariosChanged={reloadAccountData}
          onRateChangesChanged={reload}
        />
      )}
    </div>
  );
}
