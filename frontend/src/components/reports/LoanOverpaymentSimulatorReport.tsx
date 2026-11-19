'use client';

import { useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { accountsApi } from '@/lib/accounts';
import { loanScenariosApi } from '@/lib/loan-scenarios';
import { loanRateChangesApi } from '@/lib/loan-rate-changes';
import { fetchAllAccountTransactions, fetchLoanInterestTransactions } from '@/lib/loan-history';
import { useReportData } from '@/hooks/useReportData';
import { usePersistedAccountId } from '@/hooks/usePersistedAccountFilter';
import { ReportError } from '@/components/reports/ReportError';
import { ReportToolbarActions } from '@/components/reports/ReportToolbarActions';
import { LoanDetailView } from '@/components/accounts/loan-detail/LoanDetailView';
import { LineOfCreditView } from '@/components/accounts/loan-detail/LineOfCreditView';
import type { AccountType } from '@/types/account';
import type { Transaction } from '@/types/transaction';
import type { LoanScenario } from '@/types/loan-scenario';
import type { LoanRateChange } from '@/types/loan-rate-change';
import { EmptyState } from '@/components/ui/EmptyState';
import { AccountSelect } from '@/components/accounts/shared/AccountSelect';
import { accountSelectOption } from '@/lib/account-utils';

const DEBT_ACCOUNT_TYPES: AccountType[] = ['LOAN', 'MORTGAGE', 'LINE_OF_CREDIT'];

const ACCOUNT_STORAGE_KEY = 'monize-reports-loan-overpayment-simulator-account';

/**
 * Reports-section entry point for the loan overpayment simulator. Owns an
 * account selector and reuses the same detail views as the /accounts/[id]
 * page: the amortizing simulator for loans/mortgages, the balance-history
 * view for a revolving line of credit.
 */
export function LoanOverpaymentSimulatorReport() {
  const t = useTranslations('reports');
  const router = useRouter();
  /**
   * The loan view publishes its PDF export here instead of drawing its own
   * button below the card, the way the account detail header already takes it.
   * That puts the export in this report's control card, under the account it
   * exports -- on a phone it was a stray button floating outside the card.
   */
  const exportPdfRef = useRef<(() => Promise<void>) | null>(null);

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
  // Persisted so the report reopens on the account the user last looked at.
  const [persistedAccountId, setSelectedAccountId] = usePersistedAccountId(
    ACCOUNT_STORAGE_KEY,
    accounts,
  );
  const selectedAccountId = persistedAccountId || accounts[0]?.id || '';
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
          interestTransactions: [] as Transaction[],
          scenarios: [] as LoanScenario[],
          rateChanges: [] as LoanRateChange[],
        };
      }
      const [transactions, interestTransactions, scenarios, rateChanges] =
        await Promise.all([
          fetchAllAccountTransactions(selectedAccountId),
          selectedAccount
            ? fetchLoanInterestTransactions(selectedAccount)
            : Promise.resolve([] as Transaction[]),
          // No silent fallback to []: a failed list here rendered saved
          // scenarios as gone (while a re-save hits the duplicate-name 409).
          // Let the failure surface through the report's error + retry state,
          // exactly like a transactions failure on this surface.
          loanScenariosApi.getAll(selectedAccountId),
          loanRateChangesApi.getAll(selectedAccountId),
        ]);
      return { transactions, interestTransactions, scenarios, rateChanges };
    },
    [selectedAccountId, selectedAccount, isRevolving],
  );

  /** The amortizing loan body is up: the only state with a PDF to export. */
  const showsLoanDetail = Boolean(selectedAccount) && !isRevolving && !dataLoading;

  const transactions = accountData?.transactions ?? [];
  const interestTransactions = accountData?.interestTransactions ?? [];
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
        <EmptyState title={t('loanOverpayment.empty')} />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-4">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <AccountSelect
              label={t('loanOverpayment.labelSelectAccount')}
              value={selectedAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
              options={accounts
                .slice()
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((account) => accountSelectOption(account, account.name))}
              className="min-w-[200px]"
            />
          </div>
          {selectedAccount && (
            <Button
              variant="outline"
              onClick={() => router.push(`/transactions?accountId=${selectedAccount.id}`)}
              className="w-full whitespace-nowrap sm:w-auto"
            >
              {t('loanOverpayment.viewTransactions')}
            </Button>
          )}
          {/* Disabled rather than absent while the loan view is not up (no
              account, a line of credit, or still loading): there is nothing to
              export yet, and a button that comes and goes moves the row. */}
          <ReportToolbarActions
            onExportPdf={() => { void exportPdfRef.current?.(); }}
            disabled={!showsLoanDetail}
            className="sm:self-auto"
          />
        </div>
      </div>

      {selectedAccount && isRevolving && <LineOfCreditView account={selectedAccount} />}

      {selectedAccount && !isRevolving && dataLoading && (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
          <Skeleton className="h-64 w-full" />
        </div>
      )}

      {showsLoanDetail && selectedAccount && (
        <LoanDetailView
          account={selectedAccount}
          transactions={transactions}
          interestTransactions={interestTransactions}
          scenarios={scenarios}
          rateChanges={rateChanges}
          onScenariosChanged={reloadAccountData}
          onRateChangesChanged={reload}
          exportPdfRef={exportPdfRef}
        />
      )}
    </div>
  );
}
