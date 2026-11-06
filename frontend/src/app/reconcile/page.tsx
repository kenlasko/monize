'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import dynamic from 'next/dynamic';
import toast from 'react-hot-toast';
import { useTranslations } from 'next-intl';
import { ProtectedRoute } from '@/components/auth/ProtectedRoute';
import { PageLayout } from '@/components/layout/PageLayout';
import { PageHeader } from '@/components/layout/PageHeader';
import { Button } from '@/components/ui/Button';
import { DateInput } from '@/components/ui/DateInput';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { Select } from '@/components/ui/Select';
import { Modal } from '@/components/ui/Modal';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import { UnsavedChangesDialog } from '@/components/ui/UnsavedChangesDialog';
import { ReconcileTable } from '@/components/reconcile/ReconcileTable';
import {
  carryReconcileSelection,
  initialReconcileSelection,
  sumAmounts,
  type ReconcileSortField,
} from '@/components/reconcile/reconcile-rows';
import { transactionsApi } from '@/lib/transactions';
import { scheduledTransactionsApi } from '@/lib/scheduled-transactions';
import { getLocalDateString } from '@/lib/utils';
import { accountsApi } from '@/lib/accounts';
import { buildAccountDropdownOptions } from '@/lib/account-utils';
import { Account } from '@/types/account';
import { ScheduledTransaction } from '@/types/scheduled-transaction';
import { ReconciliationData, Transaction } from '@/types/transaction';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useSortableTable } from '@/hooks/useSortableTable';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useFormModal } from '@/hooks/useFormModal';
import { usePreferencesStore } from '@/store/preferencesStore';
import { nextCycleStatus } from '@/lib/transaction-status-cycle';
import {
  entryDecimalPlaces,
  moneyDecimalsFor,
  getCurrencySymbol,
  roundToDecimals,
  roundToEntryPlaces,
  withCurrencyCode,
} from '@/lib/format';
import { getErrorMessage } from '@/lib/errors';
import { notifyReconciliationChanged } from '@/lib/reconciliationSignal';

const TransactionForm = dynamic(
  () => import('@/components/transactions/TransactionForm').then((m) => m.TransactionForm),
  { ssr: false },
);

const LIABILITY_TYPES = new Set(['CREDIT_CARD', 'LOAN', 'MORTGAGE', 'LINE_OF_CREDIT']);

// Revolving-credit accounts whose balance changes each statement, so the
// payment that pays them off should track the reconciled balance. Loans and
// mortgages have fixed payments and are intentionally excluded.
const PAYMENT_PROMPT_TYPES = new Set(['CREDIT_CARD', 'LINE_OF_CREDIT']);

const SORT_STORAGE_KEY = 'reconcile.sort';
const GROUP_STORAGE_KEY = 'reconcile.groupByFlow';

type ReconcileStep = 'setup' | 'reconcile' | 'complete';

/**
 * Everything that changes what a reconciliation response *means*.
 *
 * A payload without it cannot be told from the previous account's, so the
 * reload below adopts a response only while the key it was issued under is
 * still the key on screen.
 */
function reconciliationKey(
  accountId: string,
  statementDate: string,
  statementBalance: number | undefined,
): string {
  return `${accountId}|${statementDate}|${statementBalance ?? ''}`;
}

/**
 * The account's ledger balance at the end of `date`, as a statement would show
 * it: the figure the statement ending balance is pre-filled with. Rounded to
 * the places the field holds (`entryDecimalPlaces`: a coin's own, two for
 * fiat as before), because the field
 * compares what is typed against the rounded value it holds, and plain 0
 * rather than -0. Null when the lookup failed or answered nothing: unknown,
 * not zero, so the field is left for the user.
 */
async function fetchLedgerBalance(accountId: string, date: string): Promise<number | null> {
  try {
    const points = await accountsApi.getDailyBalances({
      startDate: date,
      endDate: date,
      accountIds: accountId,
    });
    const point = points.find((p) => p.accountId === accountId && p.date === date);
    if (!point) return null;
    const balance = roundToEntryPlaces(Number(point.balance), point.currencyCode);
    return balance === 0 ? 0 : balance;
  } catch {
    return null;
  }
}

export default function ReconcilePage() {
  return (
    <ProtectedRoute>
      <ReconcileContent />
    </ProtectedRoute>
  );
}

function ReconcileContent() {
  const router = useRouter();
  const t = useTranslations('reconcile');
  const tc = useTranslations('common');
  const searchParams = useSearchParams();
  const preselectedAccountId = searchParams.get('accountId');
  const { formatCurrency, defaultCurrency } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const reconciledLocked = usePreferencesStore(
    (s) => s.preferences?.lockReconciledTransactions ?? false,
  );

  const [step, setStep] = useState<ReconcileStep>('setup');
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string>(preselectedAccountId || '');
  const [statementDate, setStatementDate] = useState<string>(
    getLocalDateString()
  );
  const [statementBalance, setStatementBalance] = useState<number | undefined>(undefined);
  const [reconciliationData, setReconciliationData] = useState<ReconciliationData | null>(null);
  const [selectedTransactionIds, setSelectedTransactionIds] = useState<Set<string>>(new Set());
  const [isLoading, setIsLoading] = useState(false);
  const [isReconciling, setIsReconciling] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Transaction | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  // Post-reconciliation liability-payment prompt: the scheduled bill (if any)
  // that pays down the reconciled liability account.
  const [paymentBill, setPaymentBill] = useState<ScheduledTransaction | null>(null);

  const { sortField, sortDirection, handleSort } = useSortableTable<ReconcileSortField>(
    SORT_STORAGE_KEY,
    { field: 'date', direction: 'asc' },
  );
  const [groupByFlow, setGroupByFlow] = useLocalStorage<boolean>(GROUP_STORAGE_KEY, false);

  const transactionModal = useFormModal<Transaction>();
  const { close: closeTransactionModal } = transactionModal;

  // The key the payload on screen was loaded under. A reload adopts its
  // response only while this still matches, so a response for the account the
  // user has left cannot replace the one they are looking at.
  const activeKey = reconciliationKey(selectedAccountId, statementDate, statementBalance);
  const activeKeyRef = useRef(activeKey);
  // Synced in an effect rather than assigned during render: a render React
  // discards must not leave the ref describing a selection that never appeared.
  useEffect(() => {
    activeKeyRef.current = activeKey;
  }, [activeKey]);

  // The ids the list on screen holds, for the reload to tell a row that has
  // newly appeared from one the user has already ticked or unticked.
  const listedIdsRef = useRef<readonly string[]>([]);
  useEffect(() => {
    listedIdsRef.current = reconciliationData?.transactions.map((tx) => tx.id) ?? [];
  }, [reconciliationData]);

  // Load accounts
  useEffect(() => {
    const loadAccounts = async () => {
      try {
        const data = await accountsApi.getAll();
        // Filter out investment brokerage accounts
        const filteredAccounts = data.filter(
          (a) => a.accountSubType !== 'INVESTMENT_BROKERAGE' && !a.isClosed
        );
        setAccounts(filteredAccounts);
      } catch (error) {
        toast.error(getErrorMessage(error, t('toasts.loadAccountsFailed')));
      }
    };
    loadAccounts();
  }, [t]);

  // Every prefill request and every typed balance takes a ticket; a ledger
  // balance is adopted only while its ticket is still the newest. So an answer
  // for an account or date the user has since left, or one arriving after they
  // typed their own figure, cannot overwrite what is on screen.
  const balanceTicketRef = useRef(0);

  // An account arriving from the accounts list is pre-filled at the initial
  // statement date, today's -- the state's own initial value.
  useEffect(() => {
    if (!preselectedAccountId) return;
    const ticket = ++balanceTicketRef.current;
    const prefill = async () => {
      const balance = await fetchLedgerBalance(preselectedAccountId, getLocalDateString());
      if (balance !== null && balanceTicketRef.current === ticket) setStatementBalance(balance);
    };
    prefill();
  }, [preselectedAccountId]);

  /** Pre-fill the statement ending balance for a newly chosen account or date. */
  const prefillStatementBalance = async (accountId: string, date: string) => {
    const ticket = ++balanceTicketRef.current;
    if (!accountId || !date) return;
    const balance = await fetchLedgerBalance(accountId, date);
    if (balance !== null && balanceTicketRef.current === ticket) setStatementBalance(balance);
  };

  const handleAccountChange = (accountId: string) => {
    setSelectedAccountId(accountId);
    void prefillStatementBalance(accountId, statementDate);
  };

  const handleStatementDateChange = (date: string) => {
    setStatementDate(date);
    void prefillStatementBalance(selectedAccountId, date);
  };

  const selectedAccount = useMemo(
    () => accounts.find((a) => a.id === selectedAccountId),
    [accounts, selectedAccountId]
  );

  const isLiability = selectedAccount ? LIABILITY_TYPES.has(selectedAccount.accountType) : false;

  // Only revolving-credit accounts get the post-reconciliation payment prompt.
  const offersPaymentPrompt = selectedAccount
    ? PAYMENT_PROMPT_TYPES.has(selectedAccount.accountType)
    : false;

  // For liability accounts, auto-negate positive entries. If the user explicitly
  // flips the sign (same absolute value), respect their choice -- mirrors the
  // sign-handling pattern in TransactionForm.
  const handleStatementBalanceChange = (value: number | undefined) => {
    // The user's own figure outranks a ledger balance still on its way.
    balanceTicketRef.current += 1;
    if (value === undefined || value === 0 || !isLiability) {
      // A typed "-0" parses to negative zero, and Intl formats -0 with a
      // leading minus -- an entered zero is stored as plain 0 either way.
      setStatementBalance(value === 0 ? 0 : value);
      return;
    }

    const currentAbs = statementBalance !== undefined ? Math.abs(statementBalance) : 0;
    const newAbs = Math.abs(value);
    const isJustSignChange = currentAbs === newAbs && currentAbs !== 0;

    if (isJustSignChange) {
      setStatementBalance(value);
      return;
    }

    setStatementBalance(value > 0 ? -value : value);
  };

  const handleStartReconciliation = async () => {
    if (!selectedAccountId || !statementDate || statementBalance === undefined) {
      toast.error(t('toasts.fillAllFields'));
      return;
    }

    setIsLoading(true);
    try {
      const data = await transactionsApi.getReconciliationData(
        selectedAccountId,
        statementDate,
        statementBalance
      );
      setReconciliationData(data);
      setSelectedTransactionIds(initialReconcileSelection(data.transactions, statementDate));

      setStep('reconcile');
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.loadDataFailed')));
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Refetch the list after a write from inside the reconcile step. Selection
   * is carried across by id (`carryReconcileSelection`).
   */
  const reloadReconciliationData = useCallback(async () => {
    if (statementBalance === undefined) return;
    const originKey = reconciliationKey(selectedAccountId, statementDate, statementBalance);
    try {
      const data = await transactionsApi.getReconciliationData(
        selectedAccountId,
        statementDate,
        statementBalance,
      );
      if (activeKeyRef.current !== originKey) return;
      const previouslyListed = new Set(listedIdsRef.current);
      setReconciliationData(data);
      // The header reminder counts outstanding rows across every account, and
      // an add, a delete or a status change here moves that count.
      notifyReconciliationChanged();
      setSelectedTransactionIds((prev) =>
        carryReconcileSelection(prev, previouslyListed, data.transactions, statementDate),
      );
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.loadDataFailed')));
    }
  }, [selectedAccountId, statementDate, statementBalance, t]);

  const handleFormSuccess = useCallback(async () => {
    closeTransactionModal();
    await reloadReconciliationData();
  }, [closeTransactionModal, reloadReconciliationData]);

  const handleDeleteConfirm = useCallback(async () => {
    if (!deleteTarget || isDeleting) return;
    setIsDeleting(true);
    try {
      if (deleteTarget.isTransfer) {
        await transactionsApi.deleteTransfer(deleteTarget.id);
        toast.success(t('toasts.transferDeleted'));
      } else {
        await transactionsApi.delete(deleteTarget.id);
        toast.success(t('toasts.deleted'));
      }
      setDeleteTarget(null);
      await reloadReconciliationData();
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.deleteFailed')));
    } finally {
      setIsDeleting(false);
    }
  }, [deleteTarget, isDeleting, reloadReconciliationData, t]);

  const handleCycleStatus = useCallback(
    async (transaction: Transaction) => {
      const next = nextCycleStatus(transaction.status);
      if (next === null) {
        toast.error(t('toasts.voidStatus'));
        return;
      }
      try {
        await transactionsApi.updateStatus(transaction.id, next);
        await reloadReconciliationData();
      } catch (error) {
        toast.error(getErrorMessage(error, t('toasts.statusFailed')));
      }
    },
    [reloadReconciliationData, t],
  );

  const handleToggleTransaction = (transactionId: string) => {
    setSelectedTransactionIds((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(transactionId)) {
        newSet.delete(transactionId);
      } else {
        newSet.add(transactionId);
      }
      return newSet;
    });
  };

  const handleSelectAll = () => {
    if (reconciliationData) {
      setSelectedTransactionIds(new Set(reconciliationData.transactions.map((t) => t.id)));
    }
  };

  const handleSelectNone = () => {
    setSelectedTransactionIds(new Set());
  };

  const selectedTransactions = useMemo(
    () =>
      reconciliationData
        ? reconciliationData.transactions.filter((tx) => selectedTransactionIds.has(tx.id))
        : [],
    [reconciliationData, selectedTransactionIds],
  );

  // Calculate the current difference based on selected transactions.
  // Both sums accumulate in integer units of the storage precision, so a long
  // statement cannot drift a cent away from the figure the user is trying to
  // match.
  // The account currency's places, and the smallest difference they can show:
  // at cents a 0.0051 BTC difference read 0.01 and let the reconciliation finish.
  const reconcileDecimals = entryDecimalPlaces(
    selectedAccount?.currencyCode || defaultCurrency,
  );
  const differenceTolerance = 10 ** -reconcileDecimals;
  // The sums are exact at the currency's money precision (a coin's eight).
  const reconcileMoneyDecimals = moneyDecimalsFor(reconcileDecimals);
  const calculatedDifference = useMemo(() => {
    if (!reconciliationData) return 0;
    const selectedSum = sumAmounts(selectedTransactions, reconcileMoneyDecimals);
    const newBalance = Number(reconciliationData.reconciledBalance) + selectedSum;
    return roundToDecimals((statementBalance ?? 0) - newBalance, reconcileDecimals);
  }, [reconciliationData, selectedTransactions, statementBalance, reconcileDecimals, reconcileMoneyDecimals]);

  const handleFinishReconciliation = async () => {
    if (Math.abs(calculatedDifference) > differenceTolerance) {
      toast.error(t('toasts.differenceRequired', { amount: formatAccountAmount(0) }));
      return;
    }

    if (selectedTransactionIds.size === 0) {
      toast.error(t('toasts.noneSelected'));
      return;
    }

    setIsReconciling(true);
    try {
      const result = await transactionsApi.bulkReconcile(
        selectedAccountId,
        Array.from(selectedTransactionIds),
        statementDate
      );
      toast.success(t('toasts.success', { count: result.reconciled }));
      notifyReconciliationChanged();

      // For revolving-credit accounts, look for an existing scheduled bill that
      // pays down this account so we can offer to update its next instance.
      if (offersPaymentPrompt) {
        try {
          const scheduled = await scheduledTransactionsApi.getAll();
          const match = scheduled.find(
            (st) =>
              (st.isTransfer && st.transferAccountId === selectedAccountId) ||
              (st.splits?.some((s) => s.transferAccountId === selectedAccountId) ?? false)
          );
          setPaymentBill(match ?? null);
        } catch {
          setPaymentBill(null);
        }
      }

      setStep('complete');
    } catch (error) {
      toast.error(getErrorMessage(error, t('toasts.reconcileFailed')));
    } finally {
      setIsReconciling(false);
    }
  };

  const handleReconcileAnother = () => {
    setStep('setup');
    setReconciliationData(null);
    setSelectedTransactionIds(new Set());
    setStatementBalance(undefined);
    setPaymentBill(null);
    void prefillStatementBalance(selectedAccountId, statementDate);
  };

  const handleCancel = () => {
    setStep('setup');
    setReconciliationData(null);
    setSelectedTransactionIds(new Set());
  };

  // The amount to apply to the liability payment: the reconciled balance owed,
  // as a positive figure (liability balances are stored negative).
  const reconciledPaymentAmount = Math.round(Math.abs(statementBalance ?? 0) * 100) / 100;

  const handleUpdatePayment = () => {
    if (!paymentBill) return;
    router.push(
      `/bills?reconcileEditId=${paymentBill.id}&reconcileAmount=${reconciledPaymentAmount}`
    );
  };

  const handleCreatePayment = () => {
    router.push(
      `/bills?reconcileCreate=1&reconcileTransferAccountId=${selectedAccountId}` +
        `&reconcileAmount=${reconciledPaymentAmount}`
    );
  };

  // Every figure on this screen is in the reconciled account's own currency.
  const accountCurrency = selectedAccount?.currencyCode || defaultCurrency;
  const formatAccountAmount = (amount: number) =>
    withCurrencyCode(formatCurrency(amount, accountCurrency), accountCurrency, defaultCurrency);

  const renderSetupStep = () => (
    <div className="max-w-xl mx-auto">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6">
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('setup.title')}
        </h2>
        <p className="text-gray-600 dark:text-gray-400 mb-6">
          {t('setup.intro')}
        </p>

        <div className="space-y-4">
          <Select
            label={t('setup.accountLabel')}
            options={[
              { value: '', label: t('setup.accountPlaceholder') },
              // Favourites first, then A-Z, as every account picker orders them.
              ...buildAccountDropdownOptions(
                accounts,
                () => true,
                // Each option is in its own account's currency, not the one
                // already selected.
                (a) =>
                  `${a.name} (${withCurrencyCode(
                    formatCurrency(Number(a.currentBalance), a.currencyCode),
                    a.currencyCode,
                    defaultCurrency,
                  )})`,
              ),
            ]}
            value={selectedAccountId}
            onChange={(e) => handleAccountChange(e.target.value)}
          />

          <DateInput
            label={t('setup.statementDateLabel')}
            value={statementDate}
            onDateChange={handleStatementDateChange}
            onChange={() => {}}
          />

          {/* No liability-specific "-0.00" placeholder: the handler above
              already negates a positive entry for a liability account, and a
              minus-signed placeholder read as a broken value, not a hint. */}
          <CurrencyInput
            label={t('setup.statementBalanceLabel')}
            prefix={getCurrencySymbol(selectedAccount?.currencyCode || defaultCurrency)}
            decimalPlaces={reconcileDecimals}
            value={statementBalance}
            onChange={handleStatementBalanceChange}
          />
        </div>

        <div className="flex justify-between mt-6">
          <Button variant="outline" onClick={() => router.push('/accounts')}>
            {tc('cancel')}
          </Button>
          <Button
            onClick={handleStartReconciliation}
            isLoading={isLoading}
            disabled={!selectedAccountId || !statementDate || statementBalance === undefined}
          >
            {t('setup.start')}
          </Button>
        </div>
      </div>
    </div>
  );

  const renderReconcileStep = () => {
    if (!reconciliationData) return null;

    const selectedCount = selectedTransactionIds.size;
    const totalCount = reconciliationData.transactions.length;

    return (
      // No horizontal inset of its own below `sm`: the <main> wrapper already
      // carries px-4 there, and stacking the two halved the table's width on a
      // phone. From `sm` up the doubled inset is the intended, roomier look.
      <div className="sm:px-6 lg:px-12">
        {/* Summary Bar. Pinned under the app header (which slides away on
            scroll, hence the offset) so the difference stays in view while the
            user works down a long statement. */}
        <div
          data-testid="reconcile-summary"
          className="sticky top-[calc(4rem-var(--app-header-offset,0px))] z-20 bg-white dark:bg-gray-800 rounded-lg shadow p-4 mb-6"
        >
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">{t('summary.statementBalance')}</p>
              <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {formatAccountAmount(statementBalance ?? 0)}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">{t('summary.reconciledBalance')}</p>
              <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {formatAccountAmount(Number(reconciliationData.reconciledBalance))}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">{t('summary.selected', { count: selectedCount })}</p>
              <p className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {formatAccountAmount(sumAmounts(selectedTransactions, reconcileMoneyDecimals))}
              </p>
            </div>
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400 uppercase">{t('summary.difference')}</p>
              <p
                className={`text-lg font-semibold ${
                  Math.abs(calculatedDifference) < differenceTolerance
                    ? 'text-green-600 dark:text-green-400'
                    : 'text-red-600 dark:text-red-400'
                }`}
              >
                {formatAccountAmount(calculatedDifference)}
              </p>
            </div>
          </div>
        </div>

        {/* Transaction List. On phones the card bleeds to the screen edge
            (cancelling <main>'s px-4) so the table gets the full device width;
            the corners square off there because a rounded card flush with the
            viewport reads as a clipping fault. */}
        <div className="bg-white dark:bg-gray-800 rounded-lg max-sm:-mx-4 max-sm:rounded-none shadow overflow-hidden">
          <div className="p-4 border-b border-gray-200 dark:border-gray-700 flex flex-wrap justify-between items-center gap-3">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {t('list.heading', { count: totalCount })}
            </h3>
            <div className="flex flex-wrap items-center gap-2">
              {/* Siblings rather than a <label> around the switch: ToggleSwitch
                  renders a button, which a label cannot be `for`, so wrapping it
                  would put a cursor-pointer on text that does nothing. The
                  accessible name comes from the switch's own aria-label. */}
              <div className="flex items-center gap-2 mr-2">
                <ToggleSwitch
                  checked={groupByFlow}
                  onChange={setGroupByFlow}
                  label={t('list.groupByFlow')}
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">
                  {t('list.groupByFlow')}
                </span>
              </div>
              {/* One non-wrapping group: the toolbar wraps on phones, and the
                  two selection buttons are halves of one control -- letting the
                  wrap split them put Select All and Select None on different
                  rows. */}
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={handleSelectAll}>
                  {t('list.selectAll')}
                </Button>
                <Button variant="outline" size="sm" onClick={handleSelectNone}>
                  {t('list.selectNone')}
                </Button>
              </div>
              <Button size="sm" onClick={transactionModal.openCreate}>
                {t('list.addTransaction')}
              </Button>
            </div>
          </div>

          {totalCount === 0 ? (
            <div className="p-6 text-center text-gray-500 dark:text-gray-400">
              {t('list.empty')}
            </div>
          ) : (
            <ReconcileTable
              transactions={reconciliationData.transactions}
              selectedIds={selectedTransactionIds}
              onToggle={handleToggleTransaction}
              sortField={sortField}
              sortDirection={sortDirection}
              onSort={handleSort}
              groupByFlow={groupByFlow}
              lastReconciledDate={reconciliationData.lastReconciledDate ?? null}
              overdueBefore={reconciliationData.overdueBefore ?? ''}
              formatCurrency={formatAccountAmount}
              moneyDecimals={reconcileMoneyDecimals}
              onEdit={transactionModal.openEdit}
              onDelete={setDeleteTarget}
              onCycleStatus={handleCycleStatus}
              reconciledLocked={reconciledLocked}
            />
          )}

          <div className="p-4 border-t border-gray-200 dark:border-gray-700 flex justify-between">
            <Button variant="outline" onClick={handleCancel}>
              {tc('cancel')}
            </Button>
            <Button
              onClick={handleFinishReconciliation}
              isLoading={isReconciling}
              disabled={Math.abs(calculatedDifference) > differenceTolerance || selectedTransactionIds.size === 0}
            >
              {t('list.finish')}
            </Button>
          </div>
        </div>
      </div>
    );
  };

  const renderCompleteStep = () => (
    <div className="max-w-xl mx-auto">
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow p-6 text-center">
        <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-green-100 dark:bg-green-900 mb-4">
          <svg
            className="h-6 w-6 text-green-600 dark:text-green-400"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M5 13l4 4L19 7"
            />
          </svg>
        </div>
        <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100 mb-2">
          {t('complete.title')}
        </h2>
        <p className="text-gray-600 dark:text-gray-400 mb-6">
          {t('complete.message', { date: formatDate(statementDate) })}
        </p>

        {/* Revolving-credit payment prompt: offer to update or create the
            scheduled bill that pays down this account, using the reconciled
            balance. */}
        {offersPaymentPrompt && (
          <div className="mb-6 rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-4 text-left">
            {paymentBill ? (
              <>
                <p className="text-sm text-gray-700 dark:text-gray-300">
                  {t.rich('complete.existingPayment', {
                    name: paymentBill.name,
                    amount: formatAccountAmount(reconciledPaymentAmount),
                    b: (chunks) => <span className="font-medium">{chunks}</span>,
                  })}
                </p>
                <div className="mt-3 flex justify-center">
                  <Button onClick={handleUpdatePayment}>
                    {t('complete.updatePayment')}
                  </Button>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-gray-700 dark:text-gray-300">
                  {t.rich('complete.noPayment', {
                    amount: formatAccountAmount(reconciledPaymentAmount),
                    b: (chunks) => <span className="font-medium">{chunks}</span>,
                  })}
                </p>
                <div className="mt-3 flex justify-center">
                  <Button onClick={handleCreatePayment}>
                    {t('complete.createPayment')}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        <div className="flex justify-center space-x-4">
          <Button variant="outline" onClick={() => router.push('/accounts')}>
            {t('complete.backToAccounts')}
          </Button>
          <Button onClick={handleReconcileAnother}>
            {t('complete.reconcileAnother')}
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <PageLayout>

      <main className="px-4 sm:px-6 lg:px-12 pt-6 pb-8">
        <PageHeader
          title={t('title')}
          subtitle={selectedAccount
            ? t('subtitleActive', { name: selectedAccount.name })
            : t('subtitle')}
        />
        {step === 'setup' && renderSetupStep()}
        {step === 'reconcile' && renderReconcileStep()}
        {step === 'complete' && renderCompleteStep()}

        <Modal
          isOpen={transactionModal.showForm}
          onClose={transactionModal.close}
          {...transactionModal.modalProps}
          maxWidth="6xl"
          className="p-6 !max-w-[69rem]"
        >
          <h2 className="text-2xl font-bold text-gray-900 dark:text-gray-100 mb-4">
            {transactionModal.isEditing ? t('form.editTitle') : t('form.newTitle')}
          </h2>
          <TransactionForm
            key={transactionModal.editingItem?.id || 'new'}
            transaction={transactionModal.editingItem}
            defaultAccountId={selectedAccountId}
            onSuccess={handleFormSuccess}
            onCancel={transactionModal.close}
            onDirtyChange={transactionModal.setFormDirty}
            submitRef={transactionModal.formSubmitRef}
          />
        </Modal>
        <UnsavedChangesDialog {...transactionModal.unsavedChangesDialog} />

        <ConfirmDialog
          isOpen={deleteTarget !== null}
          title={deleteTarget?.isTransfer ? t('delete.transferTitle') : t('delete.title')}
          message={deleteTarget?.isTransfer ? t('delete.transferMessage') : t('delete.message')}
          confirmLabel={tc('actions.delete')}
          cancelLabel={tc('cancel')}
          variant="danger"
          onConfirm={handleDeleteConfirm}
          onCancel={() => setDeleteTarget(null)}
        />
      </main>
    </PageLayout>
  );
}
