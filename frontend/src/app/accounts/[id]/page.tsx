'use client';

import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/Button';
import { PageLayout } from '@/components/layout/PageLayout';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { AccountDetailShell } from '@/components/accounts/shared/AccountDetailShell';
import { LoanDetailView } from '@/components/accounts/loan-detail/LoanDetailView';
import type { LoanSettlementsState } from '@/components/accounts/loan-detail/PaymentMatchingPanel';
import { AccountFormModal } from '@/components/accounts/AccountFormModal';
import { useFormModal } from '@/hooks/useFormModal';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import type { LoanProjectionAnchor } from '@/types/scheduled-transaction';
import { LineOfCreditView } from '@/components/accounts/loan-detail/LineOfCreditView';
import { CreditCardDetailView } from '@/components/accounts/credit-card-detail/CreditCardDetailView';
import { BankingDetailView } from '@/components/accounts/banking-detail/BankingDetailView';
import { InvestmentDetailView } from '@/components/accounts/investment-detail/InvestmentDetailView';
import { InvestmentDetailActions } from '@/components/accounts/investment-detail/InvestmentDetailActions';
import { AssetDetailView } from '@/components/accounts/asset-detail/AssetDetailView';
import { ForeignCurrencyFeesSection } from '@/components/accounts/shared/ForeignCurrencyFeesSection';
import { useOnUndoRedo } from '@/hooks/useOnUndoRedo';
import { useOnAiAction } from '@/hooks/useOnAiAction';
import { accountsApi } from '@/lib/accounts';
import { isInvestmentCashHalf } from '@/lib/account-utils';
// The per-account-type detail-view registry: which view this route renders,
// and the same list the account row's Details action and the introduction
// tour's account-detail step read.
import { resolveAccountDetailView } from '@/lib/account-detail-views';
import { loanScenariosApi } from '@/lib/loan-scenarios';
import { loanRateChangesApi } from '@/lib/loan-rate-changes';
import { fetchAllAccountTransactions, fetchLoanInterestTransactions } from '@/lib/loan-history';
import { getErrorMessage } from '@/lib/errors';
import type { Account, MortgageType } from '@/types/account';
import type { Transaction } from '@/types/transaction';
import type { LoanScenario } from '@/types/loan-scenario';
import type { LoanRateChange } from '@/types/loan-rate-change';
import { CARD_CLASS } from '@/components/ui/Card';

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
  const [interestTransactions, setInterestTransactions] = useState<Transaction[]>([]);
  const [scenarios, setScenarios] = useState<LoanScenario[]>([]);
  const [rateChanges, setRateChanges] = useState<LoanRateChange[]>([]);
  const [projectionAnchor, setProjectionAnchor] =
    useState<LoanProjectionAnchor | null>(null);
  // The installments payment matching settled, loaded with the loan history
  // so the two describe the same ledger; null off the loan view.
  const [settlements, setSettlements] = useState<LoanSettlementsState | null>(null);
  // The loan the latest load asked for: a reload answering after the user
  // switched loans is dropped instead of drawn over the new one.
  const currentAccountId = useRef(accountId);
  useLayoutEffect(() => {
    currentAccountId.current = accountId;
  });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // Switching loans shows the spinner again; set during render rather than in
  // the effect that loads the new account.
  const [loadingAccountId, setLoadingAccountId] = useState(accountId);
  if (loadingAccountId !== accountId) {
    setLoadingAccountId(accountId);
    setIsLoading(true);
    setError(null);
  }
  // Only for the caret beside the name; a failure costs the switcher, not the page.
  const [accounts, setAccounts] = useState<Account[]>([]);
  // Populated by LoanDetailView so the loan's PDF export can live in the shared
  // header, on the same row as View Transactions.
  const loanExportRef = useRef<(() => Promise<void>) | null>(null);
  // The investment view's Refresh Prices button lives in the shared header, so
  // the signal to re-fetch the body travels down instead of staying inside it.
  const [investmentRefreshKey, setInvestmentRefreshKey] = useState(0);
  // The account edit form, opened from Loan Details' mortgage type detector
  // with the confirmed type preselected; nothing is saved until the form is.
  const accountModal = useFormModal<Account>();
  const [preselectedMortgageType, setPreselectedMortgageType] =
    useState<MortgageType | undefined>(undefined);

  // Until the account loads, assume it has a dedicated page so the register
  // redirect below never fires prematurely.
  const detailView = account ? resolveAccountDetailView(account.accountType) : 'loan';
  const isRevolving = detailView === 'lineOfCredit';
  const hasDetailPage = detailView !== null;

  // The mount / account-switch load: the state already says loading.
  const fetchData = useCallback(() => {
    // Writes live in `run` so they land after the request, not during the effect.
    const run = async () => {
      try {
        const accountData = await accountsApi.getById(accountId);
        // A pair is one account, so it gets one URL: the brokerage half. A link
        // to the cash id -- an old bookmark, a deep link from a register --
        // lands on the same page rather than a second one that would carry its
        // own switcher state and history entry.
        if (isInvestmentCashHalf(accountData) && accountData.linkedAccountId) {
          router.replace(`/accounts/${accountData.linkedAccountId}`);
          return;
        }
        // Only the amortizing loan/mortgage view needs transaction history and
        // scenarios; the line-of-credit and credit-card views load their own
        // analytics, so just resolve the account for them.
        if (resolveAccountDetailView(accountData.accountType) !== 'loan') {
          setAccount(accountData);
          setTransactions([]);
          setInterestTransactions([]);
          setScenarios([]);
          setRateChanges([]);
          setSettlements(null);
          return;
        }
        // A scenario failure keeps the page usable but must not be silent: an
        // empty panel reads as "my saved scenarios are gone" while the rows still
        // exist (a retried save then hits the duplicate-name 409). Scenarios feed
        // no headline figure, so degrading to [] costs nothing but the panel.
        //
        // The rate history is NOT in that category any more. Recording a rate
        // change deliberately leaves `account.interestRate` alone, so these rows
        // are where the loan's CURRENT rate lives -- `buildLoanProjectionInput`
        // resolves both the projection's rate and its payment from them. An empty
        // list is therefore a claim ("no rate change was ever recorded"), and
        // substituting it for a failed read projects the payoff and remaining
        // interest at a stale scalar rate: at 5% against a real 12% a payment
        // short of the interest looks comfortably amortizing. So it fails with the
        // page, where the error is retryable, rather than answering with a number
        // nobody can tell is wrong.
        const [
          transactionsData,
          interestData,
          scenariosData,
          rateChangesData,
          anchorData,
          settlementsData,
        ] = await Promise.all([
          fetchAllAccountTransactions(accountId),
          fetchLoanInterestTransactions(accountData),
          loanScenariosApi.getAll(accountId).catch(() => {
            toast.error(t('loanDetail.scenarios.loadFailed'));
            return [] as LoanScenario[];
          }),
          loanRateChangesApi.getAll(accountId),
          // This page prints per-installment interest in its schedule table, so
          // it prices the same installment the amortization report does and must
          // anchor on the same boundary -- otherwise the two screens show
          // different interest for one payment (INV-LOAN-006). Like the rate
          // history above, a failed fetch fails the page rather than quietly
          // projecting from today.
          scheduledTransactionsApi.getLoanProjectionAnchor(accountId),
          // The settled installments feed no projection, so a failure costs the
          // panel's list, which then says it failed rather than that nothing
          // was settled.
          loadSettlements(accountId),
        ]);
        setAccount(accountData);
        setTransactions(transactionsData);
        setInterestTransactions(interestData);
        setScenarios(scenariosData);
        setRateChanges(rateChangesData);
        setProjectionAnchor(anchorData);
        setSettlements(settlementsData);
      } catch (err) {
        const message = getErrorMessage(err, t('loanDetail.loadFailed'));
        setError(message);
        toast.error(message);
      } finally {
        setIsLoading(false);
      }
    };
    return run();
  }, [accountId, router, t]);

  // Every other caller (retry, undo/redo, AI action, saves) shows the spinner.
  const loadData = useCallback(() => {
    setIsLoading(true);
    setError(null);
    return fetchData();
  }, [fetchData]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  useOnUndoRedo(loadData);
  useOnAiAction(loadData);

  useEffect(() => {
    let cancelled = false;
    accountsApi
      .getAll()
      .then((list) => {
        if (!cancelled) setAccounts(list);
      })
      // The switcher simply does not render without a list; the page is fine.
      .catch(() => {
        if (!cancelled) setAccounts([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const reloadScenarios = useCallback(async () => {
    try {
      setScenarios(await loanScenariosApi.getAll(accountId));
    } catch {
      // The list stays as-is (now stale, e.g. missing a just-saved scenario),
      // so say so instead of letting the user think the save was lost.
      toast.error(t('loanDetail.scenarios.loadFailed'));
    }
  }, [accountId, t]);

  // A rate-change mutation never writes the account's own interestRate /
  // paymentAmount -- those stay user-owned, set only by the edit form -- but it
  // can realign the linked scheduled bill, and the account row is what carries
  // that. So the account reloads together with the timeline. (Which of the two
  // is the loan's CURRENT rate is a separate question, answered by the timeline:
  // see buildLoanProjectionInput.)
  const reloadRateChanges = useCallback(async () => {
    try {
      const [accountData, rateChangesData, anchorData] = await Promise.all([
        accountsApi.getById(accountId),
        loanRateChangesApi.getAll(accountId),
        // A recorded rate change can resync the scheduled payment, which moves
        // the installment this page prices; re-reading it here keeps the
        // schedule table from describing the terms the user just replaced.
        scheduledTransactionsApi.getLoanProjectionAnchor(accountId),
      ]);
      setAccount(accountData);
      setRateChanges(rateChangesData);
      setProjectionAnchor(anchorData);
    } catch (err) {
      // Keeping the old timeline here would be worse than it looks. The
      // mutation SUCCEEDED, so the rows on screen are known-stale -- and since
      // the projection resolves its rate and payment from them, every figure
      // derived from them is now describing terms the user has just replaced. A
      // toast is not enough for that: it disappears, and the payoff, the
      // scenarios and the PDF export all stay live over the old rate. The
      // page's own retryable error state is the honest presentation, and the
      // same one a failed initial load gets, since it is the same prerequisite.
      const message = getErrorMessage(err, t('loanDetail.rateHistory.loadFailed'));
      setError(message);
      toast.error(message);
    }
  }, [accountId, t]);

  // Payment matching wrote to the ledger (Process history) or to the loan
  // (a new rule): the loan, its history, the anchor and the settled
  // installments reload together, without the page spinner, so the panel
  // keeps showing what the run did. A failed history read fails the page,
  // as after a rate change.
  const reloadPaymentMatching = useCallback(async () => {
    const origin = accountId;
    try {
      const accountData = await accountsApi.getById(origin);
      const [transactionsData, interestData, anchorData, settlementsData] =
        await Promise.all([
          fetchAllAccountTransactions(origin),
          fetchLoanInterestTransactions(accountData),
          scheduledTransactionsApi.getLoanProjectionAnchor(origin),
          loadSettlements(origin),
        ]);
      if (currentAccountId.current !== origin) return;
      setAccount(accountData);
      setTransactions(transactionsData);
      setInterestTransactions(interestData);
      setProjectionAnchor(anchorData);
      setSettlements(settlementsData);
    } catch (err) {
      if (currentAccountId.current !== origin) return;
      const message = getErrorMessage(err, t('loanDetail.loadFailed'));
      setError(message);
      toast.error(message);
    }
  }, [accountId, t]);

  // Account types without a registered detail view land on their transaction
  // register instead.
  useEffect(() => {
    if (account && resolveAccountDetailView(account.accountType) === null) {
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
          <div className={`${CARD_CLASS} p-12 text-center`}>
            <h3 className="text-lg font-medium text-gray-900 dark:text-gray-100 mb-2">
              {error || t('loanDetail.notFound')}
            </h3>
            <div className="flex flex-wrap items-center justify-center gap-3">
              {/*
                A failed load is retryable, so the screen has to offer the retry
                -- both for the initial load and for a rate-history reload after
                a successful mutation, where the alternative was leaving the old
                payoff live over terms the user had just replaced. Without this
                the only way out was leaving the page, which is not a retry.
              */}
              {error && <Button onClick={loadData}>{tc('errorPage.tryAgain')}</Button>}
              <Button
                variant={error ? 'secondary' : 'primary'}
                onClick={() => router.push('/accounts')}
              >
                {t('loanDetail.backToAccounts')}
              </Button>
            </div>
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
          // Same rule as the Accounts list's Edit action: a closed account is
          // reopened first, and a joint account belongs to its owner.
          onEdit={
            account.isClosed || account.isJoint
              ? undefined
              : () => {
                  setPreselectedMortgageType(undefined);
                  accountModal.openEdit(account);
                }
          }
          headerActions={
            detailView === 'investment' ? (
              <InvestmentDetailActions
                account={account}
                onRefreshComplete={() => setInvestmentRefreshKey((k) => k + 1)}
              />
            ) : undefined
          }
          onBack={() => router.push('/accounts')}
          accounts={accounts}
          onSelectAccount={(id) => router.push(`/accounts/${id}`)}
        >
          <div className="space-y-6">
            {detailView === 'creditCard' ? (
              <CreditCardDetailView account={account} />
            ) : detailView === 'banking' ? (
              <BankingDetailView account={account} />
            ) : detailView === 'investment' ? (
              <InvestmentDetailView account={account} refreshKey={investmentRefreshKey} />
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
                projectionAnchor={projectionAnchor}
                onScenariosChanged={reloadScenarios}
                onRateChangesChanged={reloadRateChanges}
                exportPdfRef={loanExportRef}
                onUseMortgageType={(type) => {
                  setPreselectedMortgageType(type);
                  accountModal.openEdit(account);
                }}
                paymentMatching={
                  settlements
                    ? { settlements, onChanged: reloadPaymentMatching }
                    : undefined
                }
              />
            )}
            {/* The section decides for itself whether to render: the fee chart
                only for accounts with a non-zero fee and foreign transactions,
                and the foreign-transaction register for any account that has
                foreign transactions. It renders nothing otherwise. */}
            <ForeignCurrencyFeesSection account={account} />
          </div>
        </AccountDetailShell>
        <AccountFormModal
          formModal={accountModal}
          onSaved={loadData}
          preselectedMortgageType={preselectedMortgageType}
        />
      </main>
    </PageLayout>
  );
}

/** A failed read is the panel's error state, never an empty list. */
function loadSettlements(accountId: string): Promise<LoanSettlementsState> {
  return accountsApi.getLoanSettlements(accountId).then(
    (rows): LoanSettlementsState => ({ status: 'ready', rows }),
    (): LoanSettlementsState => ({ status: 'error' }),
  );
}
