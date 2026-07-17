'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { PageLayout } from '@/components/layout/PageLayout';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { AccountDetailShell } from '@/components/accounts/shared/AccountDetailShell';
import { LoanDetailView } from '@/components/accounts/loan-detail/LoanDetailView';
import { LineOfCreditView } from '@/components/accounts/loan-detail/LineOfCreditView';
import { CreditCardDetailView } from '@/components/accounts/credit-card-detail/CreditCardDetailView';
import { BankingDetailView } from '@/components/accounts/banking-detail/BankingDetailView';
import { InvestmentDetailView } from '@/components/accounts/investment-detail/InvestmentDetailView';
import { AssetDetailView } from '@/components/accounts/asset-detail/AssetDetailView';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import { accountsApi } from '@/lib/accounts';
import { loanScenariosApi } from '@/lib/loan-scenarios';
import { loanRateChangesApi } from '@/lib/loan-rate-changes';
import { fetchAllAccountTransactions, fetchLoanInterestTransactions } from '@/lib/loan-history';
import { getErrorMessage } from '@/lib/errors';
import type { Account, AccountType } from '@/types/account';
import type { Transaction } from '@/types/transaction';
import type { LoanScenario } from '@/types/loan-scenario';
import type { LoanRateChange } from '@/types/loan-rate-change';

/**
 * Per-account-type detail-view registry. Phase 0 ships the two debt views;
 * later phases register credit-card, banking, investment, and asset views
 * here. A type absent from the registry has no dedicated page yet and
 * redirects to its transaction register.
 */
type DetailViewKind =
  | 'loan'
  | 'lineOfCredit'
  | 'creditCard'
  | 'banking'
  | 'investment'
  | 'asset';

const DETAIL_VIEW_REGISTRY: Partial<Record<AccountType, DetailViewKind>> = {
  LOAN: 'loan',
  MORTGAGE: 'loan',
  LINE_OF_CREDIT: 'lineOfCredit',
  CREDIT_CARD: 'creditCard',
  CHEQUING: 'banking',
  SAVINGS: 'banking',
  CASH: 'banking',
  INVESTMENT: 'investment',
  ASSET: 'asset',
  OTHER: 'asset',
};

function resolveDetailView(type: AccountType): DetailViewKind | null {
  return DETAIL_VIEW_REGISTRY[type] ?? null;
}

export default function AccountDetailPage() {
  return (
    <ProtectedRoute>
      <AccountDetailContent />
    </ProtectedRoute>
  );
}

function AccountDetailContent() {
  const t = useTranslations('accounts');
  const params = useParams();
  const router = useRouter();
  const accountId = params.id as string;

  const [account, setAccount] = useState<Account | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [interestTransactions, setInterestTransactions] = useState<Transaction[]>([]);
  const [scenarios, setScenarios] = useState<LoanScenario[]>([]);
  const [rateChanges, setRateChanges] = useState<LoanRateChange[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Populated by LoanDetailView so the loan's PDF export can live in the shared
  // header, on the same row as View Transactions.
  const loanExportRef = useRef<(() => Promise<void>) | null>(null);

  // Until the account loads, assume it has a dedicated page so the register
  // redirect below never fires prematurely.
  const detailView = account ? resolveDetailView(account.accountType) : 'loan';
  const isRevolving = detailView === 'lineOfCredit';
  const hasDetailPage = detailView !== null;

  const loadData = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const accountData = await accountsApi.getById(accountId);
      // Only the amortizing loan/mortgage view needs transaction history and
      // scenarios; the line-of-credit and credit-card views load their own
      // analytics, so just resolve the account for them.
      if (resolveDetailView(accountData.accountType) !== 'loan') {
        setAccount(accountData);
        setTransactions([]);
        setInterestTransactions([]);
        setScenarios([]);
        setRateChanges([]);
        return;
      }
      // Scenario/rate-history failures keep the page usable but must not be
      // silent: an empty panel reads as "my saved scenarios are gone" while
      // the rows still exist (a retried save then hits the duplicate-name 409).
      const [transactionsData, interestData, scenariosData, rateChangesData] =
        await Promise.all([
          fetchAllAccountTransactions(accountId),
          fetchLoanInterestTransactions(accountData),
          loanScenariosApi.getAll(accountId).catch(() => {
            toast.error(t('loanDetail.scenarios.loadFailed'));
            return [] as LoanScenario[];
          }),
          loanRateChangesApi.getAll(accountId).catch(() => {
            toast.error(t('loanDetail.rateHistory.loadFailed'));
            return [] as LoanRateChange[];
          }),
        ]);
      setAccount(accountData);
      setTransactions(transactionsData);
      setInterestTransactions(interestData);
      setScenarios(scenariosData);
      setRateChanges(rateChangesData);
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
      // The list stays as-is (now stale, e.g. missing a just-saved scenario),
      // so say so instead of letting the user think the save was lost.
      toast.error(t('loanDetail.scenarios.loadFailed'));
    }
  }, [accountId, t]);

  // Rate-change mutations can move the account's current rate/payment, so the
  // account reloads together with the timeline.
  const reloadRateChanges = useCallback(async () => {
    try {
      const [accountData, rateChangesData] = await Promise.all([
        accountsApi.getById(accountId),
        loanRateChangesApi.getAll(accountId),
      ]);
      setAccount(accountData);
      setRateChanges(rateChangesData);
    } catch {
      // The list stays as-is (stale after the mutation), so say so.
      toast.error(t('loanDetail.rateHistory.loadFailed'));
    }
  }, [accountId, t]);

  // Account types without a registered detail view land on their transaction
  // register instead.
  useEffect(() => {
    if (account && resolveDetailView(account.accountType) === null) {
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

  if (!hasDetailPage) {
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
        <AccountDetailShell
          account={account}
          onViewTransactions={
            // The investment view links to the full /investments page instead.
            detailView === 'investment'
              ? undefined
              : () => router.push(`/transactions?accountId=${account.id}`)
          }
          onReconcile={
            detailView === 'creditCard' || detailView === 'banking'
              ? () => router.push(`/reconcile?accountId=${account.id}`)
              : undefined
          }
          onExport={
            detailView === 'loan' ? () => loanExportRef.current?.() : undefined
          }
          onBack={() => router.push('/accounts')}
        >
          {detailView === 'creditCard' ? (
            <CreditCardDetailView account={account} />
          ) : detailView === 'banking' ? (
            <BankingDetailView account={account} />
          ) : detailView === 'investment' ? (
            <InvestmentDetailView account={account} />
          ) : detailView === 'asset' ? (
            <AssetDetailView account={account} onAccountChanged={loadData} />
          ) : isRevolving ? (
            <LineOfCreditView account={account} />
          ) : (
            <LoanDetailView
              account={account}
              transactions={transactions}
              interestTransactions={interestTransactions}
              scenarios={scenarios}
              rateChanges={rateChanges}
              onScenariosChanged={reloadScenarios}
              onRateChangesChanged={reloadRateChanges}
              exportPdfRef={loanExportRef}
            />
          )}
        </AccountDetailShell>
      </main>
    </PageLayout>
  );
}
