'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import toast from 'react-hot-toast';
import { investmentsApi } from '@/lib/investments';
import { getErrorMessage } from '@/lib/errors';
import { transactionsApi } from '@/lib/transactions';
import { invalidateBalanceCaches } from '@/lib/apiCache';
import { editCashRow } from '@/lib/cash-row-edit';
import { accountsApi } from '@/lib/accounts';
import { categoriesApi } from '@/lib/categories';
import { payeesApi } from '@/lib/payees';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { readPageSnapshot, writePageSnapshot } from '@/lib/page-snapshot';
import { Account } from '@/types/account';
import {
  PortfolioSummary,
  InvestmentTransaction,
  InvestmentTransactionPaginationInfo,
} from '@/types/investment';
import { Transaction } from '@/types/transaction';
import { Category } from '@/types/category';
import { Payee } from '@/types/payee';
import { usePriceRefresh } from '@/hooks/usePriceRefresh';
import { useOnAutoPriceRefresh } from '@/hooks/useOnAutoPriceRefresh';
import { useFormModal } from '@/hooks/useFormModal';
import { createLogger } from '@/lib/logger';
import { PAGE_SIZE } from '@/lib/constants';
import { type TransactionFilters } from '@/components/investments/InvestmentTransactionList';
import {
  countActiveCashFilters,
  EMPTY_CASH_FILTERS,
  type CashFilterValues,
} from '@/components/investments/CashRegisterFilters';

const logger = createLogger('Investments');

/**
 * What the page last drew, so a return draws it at once (`page-snapshot.ts`).
 * The accounts are the same whatever is selected; the summary and the first
 * page of the unfiltered register carry the selection that produced them, so
 * a return under another selection waits for its own answer. One entry each,
 * holding the latest selection's answer: a key per selection kept a full
 * portfolio summary for every selection the tab had ever seen.
 */
const ACCOUNTS_SNAPSHOT_KEY = 'investments:accounts';
interface InvestmentAccountsSnapshot {
  accounts?: Account[];
  allAccounts?: Account[];
}
function selectionKey(accountIds: readonly string[]): string {
  return [...accountIds].sort().join(',');
}
const SUMMARY_SNAPSHOT_KEY = 'investments:summary';
const TRANSACTIONS_SNAPSHOT_KEY = 'investments:transactions';
interface InvestmentTransactionsSnapshot {
  data: InvestmentTransaction[];
  pagination: InvestmentTransactionPaginationInfo | null;
}
interface SelectionSnapshot<T> {
  selection: string;
  value: T;
}
/** The stored answer, only when it was produced for this selection. */
function readSelectionSnapshot<T>(key: string, accountIds: readonly string[]): T | undefined {
  const stored = readPageSnapshot<SelectionSnapshot<T>>(key);
  return stored && stored.selection === selectionKey(accountIds) ? stored.value : undefined;
}
function writeSelectionSnapshot<T>(key: string, accountIds: readonly string[], value: T): void {
  writePageSnapshot<SelectionSnapshot<T>>(key, { selection: selectionKey(accountIds), value });
}
function rememberAccounts(update: InvestmentAccountsSnapshot): void {
  writePageSnapshot<InvestmentAccountsSnapshot>(ACCOUNTS_SNAPSHOT_KEY, {
    ...readPageSnapshot<InvestmentAccountsSnapshot>(ACCOUNTS_SNAPSHOT_KEY),
    ...update,
  });
}
/** Only the view a return lands on: page 1 with no filter. */
function isLandingView(page: number, filters: TransactionFilters): boolean {
  return page === 1 && !filters.symbol && !filters.action && !filters.startDate && !filters.endDate;
}

export function useInvestmentData() {
  const t = useTranslations('investments');
  const searchParams = useSearchParams();
  const router = useRouter();
  const [selectedAccountIds, setSelectedAccountIds] = useLocalStorage<string[]>('monize-investments-accounts', []);
  // The page's last answers, read once. A link that names an account
  // (`?accountId=`) is about to change the selection, so it draws nothing
  // from a snapshot of the remembered one.
  const [snapshot] = useState(() => {
    const accountsSnapshot = readPageSnapshot<InvestmentAccountsSnapshot>(ACCOUNTS_SNAPSHOT_KEY);
    if (searchParams.get('accountId')) return { accounts: accountsSnapshot };
    return {
      accounts: accountsSnapshot,
      summary: readSelectionSnapshot<PortfolioSummary>(SUMMARY_SNAPSHOT_KEY, selectedAccountIds),
      transactions: readSelectionSnapshot<InvestmentTransactionsSnapshot>(
        TRANSACTIONS_SNAPSHOT_KEY,
        selectedAccountIds,
      ),
    };
  });
  const [accounts, setAccounts] = useState<Account[]>(snapshot.accounts?.accounts ?? []);
  const [allAccounts, setAllAccounts] = useState<Account[]>(snapshot.accounts?.allAccounts ?? []);
  const [portfolioSummary, setPortfolioSummary] = useState<PortfolioSummary | null>(
    snapshot.summary ?? null,
  );
  const [transactions, setTransactions] = useState<InvestmentTransaction[]>(
    snapshot.transactions?.data ?? [],
  );
  const [pagination, setPagination] = useState<InvestmentTransactionPaginationInfo | null>(
    snapshot.transactions?.pagination ?? null,
  );
  const [currentPage, setCurrentPage] = useState(1);
  const [isLoading, setIsLoading] = useState(snapshot.transactions === undefined);
  const {
    showForm: showTransactionForm, editingItem: editingTransaction,
    openCreate, openEdit, close, isEditing: _isEditing,
    modalProps, setFormDirty, unsavedChangesDialog, formSubmitRef,
  } = useFormModal<InvestmentTransaction>();
  // The row a new entry is copied from (the register's Duplicate); cleared by
  // every other way of opening the form.
  const [duplicatingTransaction, setDuplicatingTransaction] = useState<
    InvestmentTransaction | undefined
  >(undefined);
  const [lastPriceUpdate, setLastPriceUpdate] = useState<string | null>(null);
  const [transactionFilters, setTransactionFilters] = useState<TransactionFilters>({});
  // Bumped by every write on either register and by a price refresh that
  // updated a quote. The sections this hook fetches are reloaded directly; the
  // Portfolio Value chart and the performance card fetch their own figures and
  // are only reachable as props, so they take this as their reload key.
  const [writeRefreshKey, setWriteRefreshKey] = useState(0);

  // Cash transaction state
  const [cashTransactions, setCashTransactions] = useState<Transaction[]>([]);
  const [cashPagination, setCashPagination] = useState<{ page: number; totalPages: number; total: number } | null>(null);
  const [cashCurrentPage, setCashCurrentPage] = useState(1);
  const [cashTransactionsLoading, setCashTransactionsLoading] = useState(false);
  const [cashStartingBalance, setCashStartingBalance] = useState<number | undefined>();
  const [showCashFilters, setShowCashFilters] = useState(false);
  // One object for the four cash filters: they are set, counted and cleared
  // together, and `CashFilterBar` -- shared with the account detail page's
  // register -- is controlled by exactly this shape.
  const [cashFilters, setCashFiltersState] = useState<CashFilterValues>(EMPTY_CASH_FILTERS);
  const [cashPayees, setCashPayees] = useState<Payee[]>([]);
  const [cashCategories, setCashCategories] = useState<Category[]>([]);
  // Set once the first load has settled and the automatic price refresh has
  // been started for it. A ref: nothing renders from it.
  const initialLoadCompleteRef = useRef(false);
  // Whether the first portfolio summary has answered (or failed). The summary
  // values the portfolio over its whole history, and so do the chart and the
  // performance card that load beside it; a price refresh that lands while
  // they are still running reloads all of them, so the server values the
  // same history a second time while the first is still in flight (#1888).
  // It is also what the summary sections wait on before leaving their
  // skeletons (`isSummaryLoading`).
  const [initialSummarySettled, setInitialSummarySettled] = useState(false);
  // A summary drawn from the snapshot leaves the skeletons at once, but is not
  // the first summary answering: the automatic price refresh still waits for
  // that, so it never revalues the history beside the mount's own valuation.
  // Only while the selection is still the one the snapshot was for: a reader
  // who picks other accounts before the first summary answers sees the
  // skeletons, not the previous selection's figures under the new one.
  const [snapshotSelection] = useState(() => selectionKey(selectedAccountIds));
  const summaryFromSnapshot =
    snapshot.summary !== undefined && selectionKey(selectedAccountIds) === snapshotSelection;

  // Cash transaction form modal
  const {
    showForm: showCashForm, editingItem: editingCashTransaction,
    openCreate: openCashCreate, openEdit: openCashEdit, close: closeCash,
    modalProps: cashModalProps, setFormDirty: setCashFormDirty,
    unsavedChangesDialog: cashUnsavedChangesDialog, formSubmitRef: cashFormSubmitRef,
  } = useFormModal<Transaction>();

  // The loaders the effects below call keep their state writes in an inner
  // async function. Every write follows the `await`, and holding them there
  // rather than in the loader itself is what lets an effect call the loader
  // without being read as a synchronous setState.
  const loadInvestmentAccounts = useCallback(() => {
    const fetchAccounts = async () => {
      try {
        const accountsData = await investmentsApi.getInvestmentAccounts();
        setAccounts(accountsData);
        rememberAccounts({ accounts: accountsData });
      } catch (error) {
        logger.error('Failed to load investment accounts:', error);
      }
    };
    return fetchAccounts();
  }, []);

  const loadAllAccounts = useCallback(() => {
    const fetchAccounts = async () => {
      try {
        const accountsData = await accountsApi.getAll();
        setAllAccounts(accountsData);
        rememberAccounts({ allAccounts: accountsData });
      } catch (error) {
        logger.error('Failed to load all accounts:', error);
      }
    };
    return fetchAccounts();
  }, []);

  const loadCashFilterData = useCallback(async () => {
    try {
      const [cats, pays] = await Promise.all([
        categoriesApi.getAll(),
        payeesApi.getAll(),
      ]);
      setCashCategories(cats);
      setCashPayees(pays);
    } catch (error) {
      logger.error('Failed to load cash filter data:', error);
    }
  }, []);

  const loadPriceStatus = useCallback(() => {
    const fetchStatus = async () => {
      try {
        const status = await investmentsApi.getPriceStatus();
        setLastPriceUpdate(status.lastUpdated);
      } catch (error) {
        logger.error('Failed to load price status:', error);
      }
    };
    return fetchStatus();
  }, []);

  // A response belongs to the request that produced it. An older selection's
  // slower answer must not overwrite the current one (e.g. a remembered
  // selection fetched on mount, then superseded by ?accountId=).
  const summarySeqRef = useRef(0);
  const transactionsSeqRef = useRef(0);
  const cashSeqRef = useRef(0);

  // A reload after the page has drawn (a write, a price refresh, a failed
  // delete) runs in the background: the sections keep their figures until the
  // new ones land and never return to their skeletons. Only the first load
  // shows those, and the first load's own loaders clear them. Flipping a
  // loading flag here put the summary, the allocation and the holdings back to
  // skeletons a second after they first drew, whenever the automatic price
  // refresh found a new quote.
  //
  // `keepOnFailure` is the reload after a price refresh: what is on screen is
  // still a valuation, an older one, so a request that fails leaves it there
  // rather than turning the page into "No data" and an empty register.
  const loadAllPortfolioData = useCallback(async (
    accountIds: string[],
    page: number = 1,
    filters: TransactionFilters = {},
    { keepOnFailure = false }: { keepOnFailure?: boolean } = {},
  ) => {
    const summarySeq = ++summarySeqRef.current;
    const txSeq = ++transactionsSeqRef.current;
    try {
      const ids = accountIds.length > 0 ? accountIds : undefined;
      const [summaryData, txResponse] = await Promise.all([
        investmentsApi.getPortfolioSummary(ids),
        investmentsApi.getTransactions({
          accountIds: ids ? ids.join(',') : undefined,
          page,
          limit: PAGE_SIZE,
          symbol: filters.symbol,
          action: filters.action,
          startDate: filters.startDate,
          endDate: filters.endDate,
        }),
      ]);
      if (summarySeqRef.current === summarySeq) {
        setPortfolioSummary(summaryData);
        setInitialSummarySettled(true);
        writeSelectionSnapshot(SUMMARY_SNAPSHOT_KEY, accountIds, summaryData);
      }
      if (transactionsSeqRef.current === txSeq) {
        setTransactions(txResponse.data || []);
        setPagination(txResponse.pagination);
        if (isLandingView(page, filters)) {
          writeSelectionSnapshot<InvestmentTransactionsSnapshot>(TRANSACTIONS_SNAPSHOT_KEY, accountIds, {
            data: txResponse.data || [],
            pagination: txResponse.pagination,
          });
        }
      }
    } catch (error) {
      logger.error('Failed to load portfolio data:', error);
      if (summarySeqRef.current === summarySeq) {
        if (!keepOnFailure) setPortfolioSummary(null);
        // This request superseded the first summary's, so its answer is the
        // one the summary sections were waiting on.
        setInitialSummarySettled(true);
      }
      if (transactionsSeqRef.current === txSeq && !keepOnFailure) {
        setTransactions([]);
        setPagination(null);
      }
    }
  }, []);

  const reloadAfterPriceRefresh = (lastUpdated?: string) => {
    // New prices move every figure valued from them, not only the summary
    // this hook fetches: the value chart and both period-result surfaces
    // (Value change / Investment result, Portfolio performance) fetch their
    // own and re-ask only when this key moves.
    setWriteRefreshKey((key) => key + 1);
    // Prefer the refresh result's timestamp, which saves a round trip; the
    // status endpoint answers from the rows' refreshed_at, so a page load
    // reads the same instant (#2385). Fall back to it if the result didn't
    // carry one (e.g. when no securities to refresh).
    if (lastUpdated) {
      setLastPriceUpdate(lastUpdated);
    } else {
      loadPriceStatus();
    }
    // Returned so the refresh button keeps spinning until the summary has
    // been re-valued: the sections keep their previous figures meanwhile,
    // and the spinner is what says they are about to change.
    return loadAllPortfolioData(selectedAccountIds, currentPage, transactionFilters, {
      keepOnFailure: true,
    });
  };

  const { isRefreshing: isRefreshingPrices, triggerManualRefresh: handleRefreshPrices, triggerAutoRefresh } = usePriceRefresh({
    onRefreshComplete: reloadAfterPriceRefresh,
    // Until the first summary is in: a refresh writing beside it would reload
    // every valuation on the page while the first ones still run (#1888).
    holdAutomaticRefresh: isLoading || !initialSummarySettled,
  });
  // The automatic refresh (the page's own once the first summary is in, then
  // every 15 minutes while the site is open) reloads the same figures; the
  // reload runs in the background, so nothing returns to its skeleton.
  useOnAutoPriceRefresh(reloadAfterPriceRefresh);

  const loadPortfolioSummary = useCallback((accountIds: string[]) => {
    const fetchSummary = async () => {
      const seq = ++summarySeqRef.current;
      try {
        const ids = accountIds.length > 0 ? accountIds : undefined;
        const summaryData = await investmentsApi.getPortfolioSummary(ids);
        if (summarySeqRef.current !== seq) return;
        setPortfolioSummary(summaryData);
        writeSelectionSnapshot(SUMMARY_SNAPSHOT_KEY, accountIds, summaryData);
      } catch (error) {
        logger.error('Failed to load portfolio summary:', error);
        if (summarySeqRef.current !== seq) return;
        setPortfolioSummary(null);
      }
      setInitialSummarySettled(true);
    };
    return fetchSummary();
  }, []);

  const loadTransactions = useCallback((
    accountIds: string[],
    page: number = 1,
    filters: TransactionFilters = {},
  ) => {
    const fetchTransactions = async () => {
      const seq = ++transactionsSeqRef.current;
      try {
        const ids = accountIds.length > 0 ? accountIds : undefined;
        const txResponse = await investmentsApi.getTransactions({
          accountIds: ids ? ids.join(',') : undefined,
          page,
          limit: PAGE_SIZE,
          symbol: filters.symbol,
          action: filters.action,
          startDate: filters.startDate,
          endDate: filters.endDate,
        });
        if (transactionsSeqRef.current !== seq) return;
        setTransactions(txResponse.data || []);
        setPagination(txResponse.pagination);
        if (isLandingView(page, filters)) {
          writeSelectionSnapshot<InvestmentTransactionsSnapshot>(TRANSACTIONS_SNAPSHOT_KEY, accountIds, {
            data: txResponse.data || [],
            pagination: txResponse.pagination,
          });
        }
      } catch (error) {
        logger.error('Failed to load transactions:', error);
        if (transactionsSeqRef.current !== seq) return;
        setTransactions([]);
        setPagination(null);
      } finally {
        setIsLoading(false);
      }
    };
    return fetchTransactions();
  }, []);

  // Derive cash account IDs from selected brokerage accounts
  const cashAccountIds = useMemo(() => {
    if (selectedAccountIds.length === 0) {
      return accounts
        .filter(a => a.accountSubType === 'INVESTMENT_BROKERAGE' && a.linkedAccountId)
        .map(a => a.linkedAccountId!);
    }
    return selectedAccountIds
      .map(id => accounts.find(a => a.id === id))
      .filter((a): a is Account => !!a && !!a.linkedAccountId)
      .map(a => a.linkedAccountId!);
  }, [selectedAccountIds, accounts]);

  const loadCashTransactions = useCallback(async (
    accountIds: string[],
    page: number = 1,
    filters: { payeeIds?: string[]; categoryIds?: string[]; startDate?: string; endDate?: string } = {},
  ) => {
    const seq = ++cashSeqRef.current;
    if (accountIds.length === 0) {
      setCashTransactions([]);
      setCashPagination(null);
      // A superseded request no longer clears the flag it set.
      setCashTransactionsLoading(false);
      return;
    }
    setCashTransactionsLoading(true);
    try {
      const response = await transactionsApi.getAll({
        accountIds,
        page,
        limit: PAGE_SIZE,
        payeeIds: filters.payeeIds?.length ? filters.payeeIds : undefined,
        categoryIds: filters.categoryIds?.length ? filters.categoryIds : undefined,
        startDate: filters.startDate || undefined,
        endDate: filters.endDate || undefined,
      });
      if (cashSeqRef.current !== seq) return;
      setCashTransactions(response.data || []);
      setCashStartingBalance(response.startingBalance);
      setCashPagination(response.pagination ? {
        page: response.pagination.page,
        totalPages: response.pagination.totalPages,
        total: response.pagination.total,
      } : null);
    } catch (error) {
      logger.error('Failed to load cash transactions:', error);
      if (cashSeqRef.current !== seq) return;
      setCashTransactions([]);
      setCashPagination(null);
    } finally {
      if (cashSeqRef.current === seq) setCashTransactionsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadInvestmentAccounts();
    loadAllAccounts();
    loadPriceStatus();
  }, [loadInvestmentAccounts, loadAllAccounts, loadPriceStatus]);

  // Apply accountId filter from URL query parameter (e.g. navigating from Accounts page)
  const accountIdAppliedRef = useRef(false);
  useEffect(() => {
    if (accountIdAppliedRef.current || accounts.length === 0) return;
    const accountId = searchParams.get('accountId');
    if (accountId) {
      accountIdAppliedRef.current = true;
      const matchingAccount = accounts.find(
        (a) => a.id === accountId && (a.accountSubType === 'INVESTMENT_BROKERAGE' || !a.accountSubType),
      );
      if (matchingAccount) {
        setSelectedAccountIds([accountId]);
      }
      router.replace('/investments', { scroll: false });
    }
  }, [accounts, searchParams, router, setSelectedAccountIds]);

  // Prune stale/non-selectable account IDs from localStorage when accounts load
  useEffect(() => {
    if (accounts.length > 0 && selectedAccountIds.length > 0) {
      const selectableIds = new Set(
        accounts
          .filter((a) => a.accountSubType === 'INVESTMENT_BROKERAGE' || !a.accountSubType)
          .map((a) => a.id),
      );
      const pruned = selectedAccountIds.filter((id) => selectableIds.has(id));
      if (pruned.length !== selectedAccountIds.length) {
        setSelectedAccountIds(pruned);
      }
    }
  }, [accounts]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load summary when account selection changes
  useEffect(() => {
    loadPortfolioSummary(selectedAccountIds);
  }, [loadPortfolioSummary, selectedAccountIds]);

  // Load transactions when page, filters, or account selection changes
  useEffect(() => {
    loadTransactions(selectedAccountIds, currentPage, transactionFilters);
  }, [loadTransactions, selectedAccountIds, currentPage, transactionFilters]);

  // Narrowing the list changes which rows page 1 holds, so a filter change
  // always returns to it.
  const setCashFilters = useCallback((next: CashFilterValues) => {
    setCashFiltersState(next);
    setCashCurrentPage(1);
  }, []);

  // Load cash transactions when view switches to 'cash' or dependencies change
  // (Caller must pass transactionView to control this)
  const loadCashTransactionsIfNeeded = useCallback((transactionView: string) => {
    if (transactionView === 'cash') {
      loadCashTransactions(cashAccountIds, cashCurrentPage, cashFilters);
    }
  }, [loadCashTransactions, cashAccountIds, cashCurrentPage, cashFilters]);

  /**
   * Everything this page shows, re-fetched after a write on either register.
   *
   * The two registers are one account's two ledgers: a trade settles into the
   * cash ledger, a cash row can carry an investment split, and both feed the
   * portfolio summary, the allocation, Holdings by Account (cash row included)
   * and the value chart. So a write on either side is a write to all of it, and
   * every write path -- create, edit, delete, status change, on both lists --
   * goes through here rather than reloading the list it happened on.
   *
   * Deleting a cash row reloaded that list alone, which is issue #1190 facing
   * the other way: the row vanished and every figure above it kept its
   * pre-delete value until the user pressed Refresh.
   *
   * Both registers are reloaded whether or not each is the visible one: which
   * view happens to be on screen is not part of whether its rows changed, and
   * toggling to a stale list is the same defect one step later.
   *
   * `invalidateBalanceCaches` only makes the *next* fetch honest, so the
   * reloads below are what actually redraws the page.
   */
  const refreshAfterWrite = useCallback(() => {
    invalidateBalanceCaches();
    loadAllPortfolioData(selectedAccountIds, currentPage, transactionFilters);
    loadCashTransactions(cashAccountIds, cashCurrentPage, cashFilters);
    setWriteRefreshKey((key) => key + 1);
  }, [
    loadAllPortfolioData, selectedAccountIds, currentPage, transactionFilters,
    loadCashTransactions, cashAccountIds, cashCurrentPage, cashFilters,
  ]);

  useEffect(() => {
    if (!isLoading && initialSummarySettled && !initialLoadCompleteRef.current) {
      initialLoadCompleteRef.current = true;
      triggerAutoRefresh();
    }
  }, [isLoading, initialSummarySettled, triggerAutoRefresh]);

  // Track which edit ID we have already handled
  const editHandledRef = useRef<string | null>(null);

  // Handle edit URL parameter (when redirected from transactions page)
  useEffect(() => {
    const editId = searchParams.get('edit');
    if (editId) {
      if (editId === editHandledRef.current) {
        router.replace('/investments', { scroll: false });
        return;
      }
      editHandledRef.current = editId;
      investmentsApi.getTransaction(editId)
        .then((transaction) => {
          openEdit(transaction);
          router.replace('/investments', { scroll: false });
        })
        .catch((error) => {
          logger.error('Failed to load investment transaction:', error);
          router.replace('/investments', { scroll: false });
        });
    } else if (!showTransactionForm) {
      editHandledRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, router, openEdit]);

  // Stable, as `selectableAccounts` below is: the page hands both to the app
  // header's collapsed-title switcher, which re-publishes on every new identity.
  const handleAccountChange = useCallback(
    (values: string[]) => {
      setSelectedAccountIds(values);
      setCurrentPage(1);
      setCashCurrentPage(1);
    },
    [setSelectedAccountIds, setCurrentPage, setCashCurrentPage],
  );

  const handleDeleteTransaction = async (id: string) => {
    // Deleting one leg of a security transfer cascades to its paired leg on
    // the backend, so drop both from the list optimistically.
    const target = transactions.find(tx => tx.id === id);
    const removeIds = new Set<string>([id]);
    if (target?.linkedTransactionId) removeIds.add(target.linkedTransactionId);
    // The backend deletes both legs of a transfer, but only legs within the
    // current filter count toward pagination.total. The deleted leg always
    // does. The paired leg counts when either no account filter is applied (the
    // whole portfolio is in the total, even if the leg sits on another page) or
    // it is loaded in the current filtered list -- otherwise it belongs to an
    // account that's filtered out and must not be subtracted.
    const linkedLoaded =
      !!target?.linkedTransactionId &&
      transactions.some(tx => tx.id === target.linkedTransactionId);
    const linkedCounts =
      !!target?.linkedTransactionId &&
      (selectedAccountIds.length === 0 || linkedLoaded);
    const removedCount = linkedCounts ? 2 : 1;
    setTransactions(prev => prev.filter(tx => !removeIds.has(tx.id)));
    // Keep the pagination summary in sync immediately so the bottom counter
    // updates without waiting for the next full reload.
    setPagination(prev => {
      if (!prev) return prev;
      const total = Math.max(0, prev.total - removedCount);
      const totalPages = Math.max(1, Math.ceil(total / prev.limit));
      return {
        ...prev,
        total,
        totalPages,
        hasMore: prev.page < totalPages,
      };
    });
    try {
      await investmentsApi.deleteTransaction(id);
      // A trade's cash leg goes with it, so the cash register, the chart and
      // the balances are all stale now -- not just the portfolio summary.
      refreshAfterWrite();
    } catch (error) {
      logger.error('Failed to delete transaction:', error);
      // Surface the backend's reason (e.g. "would cause holdings to go
      // negative") via toast instead of a native browser alert.
      toast.error(getErrorMessage(error, t('page.toastDeleteFailed')));
      loadAllPortfolioData(selectedAccountIds, currentPage, transactionFilters);
    }
  };

  const handleNewTransaction = () => {
    setDuplicatingTransaction(undefined);
    openCreate();
  };
  const handleEditTransaction = (transaction: InvestmentTransaction) => {
    setDuplicatingTransaction(undefined);
    openEdit(transaction);
  };
  const handleDuplicateTransaction = (transaction: InvestmentTransaction) => {
    setDuplicatingTransaction(transaction);
    openCreate();
  };

  // "Create & New" keeps the form open, so the page only refreshes what it
  // shows behind it -- everything `handleFormSuccess` does bar the close.
  const handleFormCreateAndNew = () => {
    // The form restarts blank, so the modal stops calling it a duplicate.
    setDuplicatingTransaction(undefined);
    refreshAfterWrite();
  };

  const handleFormSuccess = () => {
    close();
    handleFormCreateAndNew();
  };

  // Cash transaction handlers
  const handleEditCashTransaction = (transaction: Transaction) =>
    editCashRow(transaction, {
      // The investment form is mounted on this page already, so a trade's cash
      // leg opens it here. Routing to `?edit=<id>` reached the same modal by
      // navigating, which remounted the page and scrolled it to the top first;
      // the URL parameter stays for arrivals from elsewhere.
      openInvestment: openEdit,
      openCash: openCashEdit,
      onLookupFailed: (error) =>
        toast.error(getErrorMessage(error, t('page.toastLoadFailed'))),
    });

  const handleCashTransactionUpdate = useCallback((updatedTx: Transaction) => {
    setCashTransactions(prev => prev.map(tx => tx.id === updatedTx.id ? updatedTx : tx));
  }, []);

  const handleCashFormCreateAndNew = () => {
    refreshAfterWrite();
  };

  const handleCashFormSuccess = () => {
    closeCash();
    handleCashFormCreateAndNew();
  };

  const handleFiltersChange = (newFilters: TransactionFilters) => {
    setTransactionFilters(newFilters);
    setCurrentPage(1);
  };

  const clearCashFilters = () => setCashFilters(EMPTY_CASH_FILTERS);

  const activeCashFilterCount = countActiveCashFilters(cashFilters);
  const hasActiveCashFilters = activeCashFilterCount > 0;

  // Clicking a holding opens that security's detail page (review of discussion
  // #964). It used to filter the transaction list by symbol instead; the filters
  // above that list still do that, and the page is the more useful destination.
  const handleSecurityClick = (securityId: string) => {
    router.push(`/securities/${securityId}`);
  };

  const handleCashClick = (cashAccountId: string) => {
    router.push(`/transactions?accountId=${cashAccountId}`);
  };

  const goToPage = (page: number) => {
    if (page >= 1 && (!pagination || page <= pagination.totalPages)) {
      setCurrentPage(page);
    }
  };

  const goToCashPage = (page: number) => {
    if (page >= 1 && (!cashPagination || page <= cashPagination.totalPages)) {
      setCashCurrentPage(page);
    }
  };

  const getSelectedBrokerageAccountId = () => {
    if (selectedAccountIds.length === 0) return undefined;
    return selectedAccountIds[0];
  };

  // Get selectable investment accounts (brokerage and standalone), sorted
  // alphabetically by name. Without an explicit sort the dropdown order follows
  // whatever order the API returned the accounts in, which can shift between
  // loads and makes the selection dropdown appear to reorder at random.
  // filter() returns a fresh array, so sorting it in place does not mutate state.
  const selectableAccounts = useMemo(
    () =>
      accounts
        .filter((a) => a.accountSubType === 'INVESTMENT_BROKERAGE' || !a.accountSubType)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [accounts],
  );

  return {
    // Accounts
    accounts, allAccounts, selectedAccountIds, selectableAccounts,
    handleAccountChange,

    // Portfolio. `isSummaryLoading` gates the sections drawn from the summary
    // (summary card, allocation, holdings); `isLoading` gates the brokerage
    // register. The register answers in a fraction of the time the summary's
    // valuation takes, and gating the summary sections on it showed them as
    // "no data" until the summary arrived.
    portfolioSummary, isLoading,
    isSummaryLoading: !initialSummarySettled && !summaryFromSnapshot,
    loadAllPortfolioData, refreshAfterWrite, writeRefreshKey,

    // Brokerage transactions
    transactions, pagination, currentPage,
    transactionFilters, handleFiltersChange,
    handleDeleteTransaction, handleNewTransaction, handleEditTransaction, handleFormSuccess,
    handleDuplicateTransaction,
    handleFormCreateAndNew,
    handleSecurityClick, goToPage,

    // Transaction form modal
    showTransactionForm, editingTransaction, duplicatingTransaction,
    close, modalProps, setFormDirty, unsavedChangesDialog, formSubmitRef,
    getSelectedBrokerageAccountId,

    // Price refresh
    isRefreshingPrices, lastPriceUpdate, handleRefreshPrices,

    // Cash transactions
    cashAccountIds, cashTransactions, cashPagination, cashCurrentPage,
    cashTransactionsLoading, cashStartingBalance, cashPayees, cashCategories,
    cashFilters, setCashFilters,
    showCashFilters, setShowCashFilters,
    hasActiveCashFilters, activeCashFilterCount,
    handleEditCashTransaction, handleCashTransactionUpdate, handleCashFormSuccess,
    handleCashFormCreateAndNew,
    clearCashFilters,
    goToCashPage, handleCashClick,
    loadCashFilterData, loadCashTransactionsIfNeeded,
    setCashCurrentPage,
    openCashCreate,

    // Cash form modal
    showCashForm, editingCashTransaction, closeCash,
    cashModalProps, setCashFormDirty, cashUnsavedChangesDialog, cashFormSubmitRef,
  };
}
