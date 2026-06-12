'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Account, AccountType } from '@/types/account';
import { Institution } from '@/types/institution';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Modal } from '@/components/ui/Modal';
import { accountsApi } from '@/lib/accounts';
import { useAuthStore } from '@/store/authStore';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import toast from 'react-hot-toast';
import { getErrorMessage } from '@/lib/errors';
import { AccountRow } from './AccountRow';
import { useTableDensity, nextDensity, type DensityLevel } from '@/hooks/useTableDensity';
import { SortIcon } from '@/components/ui/SortIcon';
import { formatAccountType, countLogicalAccounts } from '@/lib/account-utils';

type SortField = 'name' | 'type' | 'balance' | 'status';
type SortDirection = 'asc' | 'desc';

// LocalStorage keys for filter persistence
const STORAGE_KEYS = {
  showFilters: 'accounts.filter.showFilters',
  status: 'accounts.filter.status',
  netWorth: 'accounts.filter.netWorth',
  sortField: 'accounts.filter.sortField',
  sortDirection: 'accounts.filter.sortDirection',
  density: 'accounts.filter.density',
  collapsedGroups: 'accounts.filter.collapsedGroups',
};

// Display order for account-type groups: assets first, then liabilities.
const ACCOUNT_TYPE_ORDER: AccountType[] = [
  // Banking
  'CHEQUING',
  'SAVINGS',
  'CREDIT_CARD',
  'FSA',
  'DCFSA',
  // Investing & Retirement
  'INVESTMENT',
  'HSA',
  '401K',
  '403B',
  'TRADITIONAL_IRA',
  'ROTH_IRA',
  '529_PLAN',
  // Loan & Debt
  'LOAN',
  'MORTGAGE',
  'LINE_OF_CREDIT',
  'HELOC',
  'LIABILITY',
  // Other Assets & Liabilities
  'CASH',
  'PROPERTY',
  'VEHICLE',
  'ASSET',
  'OTHER',
];

// Helper to get stored value
function getStoredValue<T>(key: string, defaultValue: T): T {
  if (typeof window === 'undefined') return defaultValue;
  const stored = localStorage.getItem(key);
  if (!stored) return defaultValue;
  try {
    return JSON.parse(stored) as T;
  } catch {
    return defaultValue;
  }
}

const getAccountTypeColor = (type: AccountType) => {
  switch (type) {
    case 'CHEQUING':
      return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200';
    case 'SAVINGS':
      return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200';
    case 'CREDIT_CARD':
      return 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200';
    case 'INVESTMENT':
    case '401K':
    case '403B':
    case 'TRADITIONAL_IRA':
    case 'ROTH_IRA':
    case '529_PLAN':
      return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200';
    case 'LOAN':
    case 'LIABILITY':
      return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200';
    case 'MORTGAGE':
      return 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200';
    case 'CASH':
    case 'HSA':
    case 'FSA':
    case 'DCFSA':
      return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200';
    case 'LINE_OF_CREDIT':
    case 'HELOC':
      return 'bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-200';
    case 'ASSET':
    case 'PROPERTY':
    case 'VEHICLE':
      return 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200';
    default:
      return 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200';
  }
};

interface AccountListProps {
  accounts: Account[];
  institutions?: Institution[];
  brokerageMarketValues?: Map<string, number>;
  defaultCurrency: string;
  convertToDefault: (value: number, fromCurrency: string) => number;
  onEdit: (account: Account) => void;
  onRefresh: () => void;
}

export function AccountList({ accounts, institutions, brokerageMarketValues, defaultCurrency, convertToDefault, onEdit, onRefresh }: AccountListProps) {
  const t = useTranslations('accounts');
  const tc = useTranslations('common');
  const router = useRouter();
  const isDelegateView = useAuthStore((s) => !!s.actingAsUserId);
  const { formatCurrency: formatCurrencyBase } = useNumberFormat();
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [accountToClose, setAccountToClose] = useState<Account | null>(null);
  const [accountToDelete, setAccountToDelete] = useState<Account | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  // Optimistic favourite state so toggling the star does not trigger a full
  // page reload. Keyed by account id; absence means "use the prop value".
  const [favOverrides, setFavOverrides] = useState<Record<string, boolean>>({});
  const deletableAccounts = useMemo(
    () => new Set(accounts.filter(a => a.canDelete).map(a => a.id)),
    [accounts],
  );

  // Sorting state - initialize from localStorage
  const [sortField, setSortField] = useState<SortField>(() =>
    getStoredValue<SortField>(STORAGE_KEYS.sortField, 'name')
  );
  const [sortDirection, setSortDirection] = useState<SortDirection>(() =>
    getStoredValue<SortDirection>(STORAGE_KEYS.sortDirection, 'asc')
  );

  // Filter state - initialize from localStorage
  const [showFilters, _setShowFilters] = useState(() =>
    getStoredValue<boolean>(STORAGE_KEYS.showFilters, false)
  );
  const [filterStatus, setFilterStatus] = useState<'active' | 'closed' | ''>(() =>
    getStoredValue<'active' | 'closed' | ''>(STORAGE_KEYS.status, '')
  );
  const [filterNetWorth, setFilterNetWorth] = useState<'included' | 'excluded' | ''>(() =>
    getStoredValue<'included' | 'excluded' | ''>(STORAGE_KEYS.netWorth, '')
  );

  // Density state - initialize from localStorage
  const [density, setDensity] = useState<DensityLevel>(() =>
    getStoredValue<DensityLevel>(STORAGE_KEYS.density, 'normal')
  );

  // Collapsed account-type groups - initialize from localStorage
  const [collapsedGroups, setCollapsedGroups] = useState<Set<AccountType>>(() => {
    const stored = getStoredValue<AccountType[]>(STORAGE_KEYS.collapsedGroups, []);
    return new Set(stored);
  });

  const toggleGroup = useCallback((type: AccountType) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(type)) {
        next.delete(type);
      } else {
        next.add(type);
      }
      return next;
    });
  }, []);

  // Persist filter/sort changes to localStorage
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.showFilters, JSON.stringify(showFilters));
  }, [showFilters]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.status, JSON.stringify(filterStatus));
  }, [filterStatus]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.netWorth, JSON.stringify(filterNetWorth));
  }, [filterNetWorth]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.sortField, JSON.stringify(sortField));
  }, [sortField]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.sortDirection, JSON.stringify(sortDirection));
  }, [sortDirection]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.density, JSON.stringify(density));
  }, [density]);

  useEffect(() => {
    localStorage.setItem(
      STORAGE_KEYS.collapsedGroups,
      JSON.stringify(Array.from(collapsedGroups)),
    );
  }, [collapsedGroups]);

  // Long-press handling for context menu on mobile
  const longPressTimer = useRef<NodeJS.Timeout | null>(null);
  const longPressTriggered = useRef(false);
  const touchStartPos = useRef<{ x: number; y: number } | null>(null);
  const LONG_PRESS_MOVE_THRESHOLD = 10;
  const [contextAccount, setContextAccount] = useState<Account | null>(null);

  const handleLongPressStart = useCallback((account: Account, e?: React.TouchEvent) => {
    if (e?.touches?.[0]) {
      touchStartPos.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    } else {
      touchStartPos.current = null;
    }

    longPressTriggered.current = false;
    longPressTimer.current = setTimeout(() => {
      longPressTriggered.current = true;
      setContextAccount(account);
    }, 750);
  }, []);

  const handleLongPressEnd = useCallback(() => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
    touchStartPos.current = null;
  }, []);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (touchStartPos.current && longPressTimer.current && e.touches?.[0]) {
      const deltaX = Math.abs(e.touches[0].clientX - touchStartPos.current.x);
      const deltaY = Math.abs(e.touches[0].clientY - touchStartPos.current.y);
      if (deltaX > LONG_PRESS_MOVE_THRESHOLD || deltaY > LONG_PRESS_MOVE_THRESHOLD) {
        clearTimeout(longPressTimer.current);
        longPressTimer.current = null;
        touchStartPos.current = null;
      }
    }
  }, []);

  const handleRowClick = useCallback((account: Account) => {
    if (longPressTriggered.current) {
      longPressTriggered.current = false;
      return;
    }
    if (account.accountSubType === 'INVESTMENT_BROKERAGE') {
      router.push(`/investments?accountId=${account.id}`);
    } else {
      router.push(`/transactions?accountId=${account.id}`);
    }
  }, [router]);
  const { cellPadding, headerPadding } = useTableDensity(density);

  const cycleDensity = useCallback(() => {
    setDensity(prev => nextDensity(prev));
  }, []);

  // Filter and sort accounts
  const filteredAndSortedAccounts = useMemo(() => {
    let result = accounts.map((a) =>
      a.id in favOverrides
        ? { ...a, isFavourite: favOverrides[a.id] }
        : a,
    );

    // Apply filters
    if (filterStatus) {
      result = result.filter((a) =>
        filterStatus === 'active' ? !a.isClosed : a.isClosed
      );
    }
    if (filterNetWorth) {
      result = result.filter((a) =>
        filterNetWorth === 'excluded' ? a.excludeFromNetWorth : !a.excludeFromNetWorth
      );
    }

    // Apply sorting
    result.sort((a, b) => {
      let comparison = 0;
      switch (sortField) {
        case 'name':
          comparison = a.name.localeCompare(b.name);
          break;
        case 'type':
          comparison = a.accountType.localeCompare(b.accountType);
          break;
        case 'balance':
          comparison = ((Number(a.currentBalance) || 0) + (Number(a.futureTransactionsSum) || 0)) -
            ((Number(b.currentBalance) || 0) + (Number(b.futureTransactionsSum) || 0));
          break;
        case 'status':
          comparison = (a.isClosed ? 1 : 0) - (b.isClosed ? 1 : 0);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return result;
  }, [accounts, favOverrides, filterStatus, filterNetWorth, sortField, sortDirection]);

  // Build a map of account IDs to names for showing linked account pairs
  const accountNameMap = useMemo(() => {
    const map = new Map<string, string>();
    accounts.forEach((a) => map.set(a.id, a.name));
    return map;
  }, [accounts]);

  // Map institution id -> institution for the per-row brand icon.
  const institutionsById = useMemo(() => {
    const map = new Map<string, Institution>();
    (institutions || []).forEach((i) => map.set(i.id, i));
    return map;
  }, [institutions]);

  // Group accounts by account type. Within the INVESTMENT group, ensure linked
  // brokerage/cash pairs are rendered adjacently (brokerage first).
  const groupedAccounts = useMemo(() => {
    const groups = new Map<AccountType, Account[]>();
    for (const account of filteredAndSortedAccounts) {
      const existing = groups.get(account.accountType);
      if (existing) {
        existing.push(account);
      } else {
        groups.set(account.accountType, [account]);
      }
    }

    const investments = groups.get('INVESTMENT');
    if (investments && investments.length > 1) {
      const byId = new Map(investments.map((a) => [a.id, a]));
      const placed = new Set<string>();
      const ordered: Account[] = [];
      for (const account of investments) {
        if (placed.has(account.id)) continue;
        const partner = account.linkedAccountId
          ? byId.get(account.linkedAccountId)
          : undefined;
        if (partner && !placed.has(partner.id)) {
          // Brokerage first, then its paired cash account.
          const brokerage =
            account.accountSubType === 'INVESTMENT_BROKERAGE' ? account : partner;
          const cash = brokerage === account ? partner : account;
          ordered.push(brokerage);
          ordered.push(cash);
          placed.add(brokerage.id);
          placed.add(cash.id);
        } else {
          ordered.push(account);
          placed.add(account.id);
        }
      }
      groups.set('INVESTMENT', ordered);
    }

    const result: { type: AccountType; accounts: Account[] }[] = [];
    for (const type of ACCOUNT_TYPE_ORDER) {
      const list = groups.get(type);
      if (list && list.length > 0) {
        result.push({ type, accounts: list });
        groups.delete(type);
      }
    }
    // Append any unrecognised types last (defensive against new enum values).
    for (const [type, list] of groups) {
      if (list.length > 0) result.push({ type, accounts: list });
    }
    return result;
  }, [filteredAndSortedAccounts]);

  // Per-group total balance, converted into the user's default currency.
  // Brokerage accounts use their portfolio market value (matching the page
  // summary calculation) so net-worth math stays consistent with the cards
  // above the list.
  const groupTotals = useMemo(() => {
    const totals = new Map<AccountType, number>();
    for (const { type, accounts: groupAccounts } of groupedAccounts) {
      let totalUnits = 0;
      for (const account of groupAccounts) {
        const rawBalance =
          account.accountSubType === 'INVESTMENT_BROKERAGE'
            ? brokerageMarketValues?.get(account.id) ?? 0
            : (Number(account.currentBalance) || 0) +
              (Number(account.futureTransactionsSum) || 0);
        const converted = convertToDefault(rawBalance, account.currencyCode);
        // Accumulate in 1/10000 units to avoid floating-point drift.
        totalUnits += Math.round(converted * 10000);
      }
      totals.set(type, totalUnits / 10000);
    }
    return totals;
  }, [groupedAccounts, brokerageMarketValues, convertToDefault]);

  // Flatten groups into a sequence of header / row entries with stable striping
  // indices so AccountRow alternation continues to look right across groups.
  const renderItems = useMemo(() => {
    type Item =
      | { kind: 'header'; type: AccountType; count: number; total: number; isCollapsed: boolean }
      | { kind: 'row'; account: Account; index: number };
    const items: Item[] = [];
    let rowIndex = 0;
    for (const { type, accounts: groupAccounts } of groupedAccounts) {
      const isCollapsed = collapsedGroups.has(type);
      items.push({
        kind: 'header',
        type,
        count: countLogicalAccounts(groupAccounts),
        total: groupTotals.get(type) ?? 0,
        isCollapsed,
      });
      if (!isCollapsed) {
        for (const account of groupAccounts) {
          items.push({ kind: 'row', account, index: rowIndex });
          rowIndex += 1;
        }
      }
    }
    return items;
  }, [groupedAccounts, collapsedGroups, groupTotals]);

  // Only show the net worth filter when at least one account is excluded
  const hasExcludedAccounts = useMemo(
    () => accounts.some((a) => a.excludeFromNetWorth),
    [accounts],
  );

  // Clear the net worth filter if no accounts are excluded (e.g. user toggled the flag off)
  useEffect(() => {
    if (!hasExcludedAccounts && filterNetWorth) {
      setFilterNetWorth('');
    }
  }, [hasExcludedAccounts, filterNetWorth]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const clearFilters = () => {
    setFilterStatus('');
    setFilterNetWorth('');
    localStorage.removeItem(STORAGE_KEYS.status);
    localStorage.removeItem(STORAGE_KEYS.netWorth);
  };


  const handleViewTransactions = useCallback((account: Account) => {
    if (account.accountSubType === 'INVESTMENT_BROKERAGE') {
      router.push(`/investments?accountId=${account.id}`);
    } else {
      router.push(`/transactions?accountId=${account.id}`);
    }
  }, [router]);

  const handleReconcile = useCallback((account: Account) => {
    router.push(`/reconcile?accountId=${account.id}`);
  }, [router]);

  const handleCloseClick = useCallback((account: Account) => {
    setAccountToClose(account);
    setCloseDialogOpen(true);
  }, []);

  const handleDeleteClick = useCallback((account: Account) => {
    setAccountToDelete(account);
    setDeleteDialogOpen(true);
  }, []);

  const handleDeleteConfirm = async () => {
    if (!accountToDelete) return;

    setIsDeleting(true);
    try {
      await accountsApi.delete(accountToDelete.id);
      toast.success(t('toast.deleteSuccess'));
      setDeleteDialogOpen(false);
      setAccountToDelete(null);
      onRefresh();
    } catch (error) {
      toast.error(getErrorMessage(error, t('toast.deleteFailed')));
    } finally {
      setIsDeleting(false);
    }
  };

  const handleDeleteCancel = () => {
    setDeleteDialogOpen(false);
    setAccountToDelete(null);
  };

  const handleCloseConfirm = async () => {
    if (!accountToClose) return;

    setIsClosing(true);
    try {
      await accountsApi.close(accountToClose.id);
      toast.success(t('toast.closeSuccess'));
      setCloseDialogOpen(false);
      setAccountToClose(null);
      onRefresh();
    } catch (error) {
      toast.error(getErrorMessage(error, t('toast.closeFailed')));
    } finally {
      setIsClosing(false);
    }
  };

  const handleCloseCancel = () => {
    setCloseDialogOpen(false);
    setAccountToClose(null);
  };

  const handleReopen = useCallback(async (account: Account) => {
    try {
      await accountsApi.reopen(account.id);
      toast.success(t('toast.reopenSuccess'));
      onRefresh();
    } catch (error) {
      toast.error(getErrorMessage(error, t('toast.reopenFailed')));
    }
  }, [onRefresh, t]);

  const handleToggleFavourite = useCallback(
    async (account: Account) => {
      const next = !account.isFavourite;
      // Optimistically flip the star in place -- no list reload/spinner.
      setFavOverrides((prev) => ({ ...prev, [account.id]: next }));
      try {
        // Owner favourites live on the account row; a delegate keeps an
        // independent overlay (the owner-scoped flag is never touched).
        if (isDelegateView) {
          await accountsApi.setDelegateFavourite(account.id, next);
        } else {
          await accountsApi.update(account.id, { isFavourite: next });
        }
      } catch (error) {
        // Roll back the optimistic change on failure.
        setFavOverrides((prev) => ({ ...prev, [account.id]: !next }));
        toast.error(getErrorMessage(error, t('toast.favouriteError')));
      }
    },
    [isDelegateView, t],
  );

  const formatCurrency = useCallback((amount: number | string | null | undefined, currency: string) => {
    const numericAmount = Number(amount) || 0;
    const formatted = formatCurrencyBase(numericAmount, currency);

    // Only show currency code if it differs from user's default currency
    if (currency !== defaultCurrency) {
      return `${formatted} ${currency}`;
    }
    return formatted;
  }, [formatCurrencyBase, defaultCurrency]);

  if (accounts.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500 dark:text-gray-400">{t('list.empty')}</p>
      </div>
    );
  }

  return (
    <div>
      {/* Filter Bar */}
      <div className="px-3 sm:px-6 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-4">
            {/* Status segmented control and Net Worth filter */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 sm:gap-3">
              {/* Status segmented control */}
              <div className="inline-flex rounded-md shadow-sm">
              <button
                onClick={() => setFilterStatus('')}
                className={`px-3 py-1.5 text-sm font-medium rounded-l-md border ${
                  filterStatus === ''
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
                }`}
              >
                {t('list.filter.all')}
              </button>
              <button
                onClick={() => setFilterStatus('active')}
                className={`px-3 py-1.5 text-sm font-medium border-t border-b ${
                  filterStatus === 'active'
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
                }`}
              >
                {t('list.filter.active')}
              </button>
              <button
                onClick={() => setFilterStatus('closed')}
                className={`px-3 py-1.5 text-sm font-medium rounded-r-md border ${
                  filterStatus === 'closed'
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
                }`}
              >
                {t('list.filter.closed')}
              </button>
              </div>

              {/* Net Worth filter -- only shown when at least one account is excluded */}
              {hasExcludedAccounts && (
                <select
                  value={filterNetWorth}
                  onChange={(e) => setFilterNetWorth(e.target.value as 'included' | 'excluded' | '')}
                  className="text-sm font-sans border border-gray-300 dark:border-gray-600 rounded-md px-3 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 min-w-[16rem]"
                >
                  <option value="">{t('list.filter.netWorthAll')}</option>
                  <option value="included">{t('list.filter.inNetWorth')}</option>
                  <option value="excluded">{t('list.filter.excludedFromNetWorth')}</option>
                </select>
              )}
            </div>
          </div>
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {t('list.accountCount', { filtered: countLogicalAccounts(filteredAndSortedAccounts), total: countLogicalAccounts(accounts) })}
          </span>
        </div>
      </div>

      {filteredAndSortedAccounts.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 dark:text-gray-400">{t('list.noMatch')}</p>
          <button
            onClick={clearFilters}
            className="mt-2 text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
          >
            {t('list.clearFilters')}
          </button>
        </div>
      ) : (
      <div>
        {/* Density toggle */}
        <div className="flex justify-end p-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
          <button
            onClick={cycleDensity}
            className="inline-flex items-center px-2 py-1 text-xs font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
            title={t('list.density.toggle')}
          >
            <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            {density === 'normal' ? t('list.density.normal') : density === 'compact' ? t('list.density.compact') : t('list.density.dense')}
          </button>
        </div>
        <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-800">
            <tr>
              <th
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none`}
                onClick={() => handleSort('name')}
              >
                <div className="flex items-center">
                  {t('list.columns.accountName')}
                  <SortIcon field="name" sortField={sortField} sortDirection={sortDirection} />
                </div>
              </th>
              <th
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none hidden sm:table-cell`}
                onClick={() => handleSort('type')}
              >
                <div className="flex items-center">
                  {t('list.columns.type')}
                  <SortIcon field="type" sortField={sortField} sortDirection={sortDirection} />
                </div>
              </th>
              <th
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none hidden md:table-cell w-1 whitespace-nowrap`}
                onClick={() => handleSort('status')}
              >
                <div className="flex items-center">
                  {t('list.columns.status')}
                  <SortIcon field="status" sortField={sortField} sortDirection={sortDirection} />
                </div>
              </th>
              <th
                className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none`}
                onClick={() => handleSort('balance')}
              >
                <div className="flex items-center justify-end">
                  {t('list.columns.balance')}
                  <SortIcon field="balance" sortField={sortField} sortDirection={sortDirection} />
                </div>
              </th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden min-[480px]:table-cell sticky right-0 bg-gray-50 dark:bg-gray-800`}>
                {t('list.columns.actions')}
              </th>
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
            {renderItems.map((item) =>
              item.kind === 'header' ? (
                <tr
                  key={`group-${item.type}`}
                  className="group bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 cursor-pointer select-none"
                  onClick={() => toggleGroup(item.type)}
                  aria-expanded={!item.isCollapsed}
                >
                  <td className={cellPadding}>
                    <div className="flex items-center gap-2 min-w-0 text-sm">
                      <svg
                        className={`w-4 h-4 text-gray-500 dark:text-gray-400 transition-transform ${item.isCollapsed ? '-rotate-90' : ''}`}
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        aria-hidden="true"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                      <span className="font-semibold text-gray-700 dark:text-gray-200">
                        {formatAccountType(item.type, tc)}
                      </span>
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {t('list.groupCount', { count: item.count })}
                      </span>
                    </div>
                  </td>
                  <td className="hidden sm:table-cell" aria-hidden="true" />
                  <td className="hidden md:table-cell" aria-hidden="true" />
                  <td className={`${cellPadding} text-right whitespace-nowrap`}>
                    <span
                      className={`text-sm font-medium ${
                        item.total >= 0
                          ? 'text-gray-700 dark:text-gray-200'
                          : 'text-red-600 dark:text-red-400'
                      }`}
                    >
                      {formatCurrencyBase(item.total, defaultCurrency)}
                    </span>
                  </td>
                  <td
                    className="hidden min-[480px]:table-cell sticky right-0 bg-gray-100 dark:bg-gray-800 group-hover:bg-gray-200 dark:group-hover:bg-gray-700"
                    aria-hidden="true"
                  />
                </tr>
              ) : (
                <AccountRow
                  key={item.account.id}
                  account={item.account}
                  index={item.index}
                  density={density}
                  cellPadding={cellPadding}
                  isDeletable={deletableAccounts.has(item.account.id)}
                  accountNameMap={accountNameMap}
                  institution={item.account.institutionId ? institutionsById.get(item.account.institutionId) : undefined}
                  brokerageMarketValue={brokerageMarketValues?.get(item.account.id)}
                  defaultCurrency={defaultCurrency}
                  formatCurrency={formatCurrency}
                  formatCurrencyBase={formatCurrencyBase}
                  convertToDefault={convertToDefault}
                  formatAccountType={(type) => formatAccountType(type, tc)}
                  getAccountTypeColor={getAccountTypeColor}
                  onRowClick={handleRowClick}
                  onEdit={onEdit}
                  onReconcile={handleReconcile}
                  onCloseClick={handleCloseClick}
                  onDeleteClick={handleDeleteClick}
                  onReopen={handleReopen}
                  onLongPressStart={handleLongPressStart}
                  onLongPressStartTouch={handleLongPressStart}
                  onLongPressEnd={handleLongPressEnd}
                  onTouchMove={handleTouchMove}
                  onToggleFavourite={handleToggleFavourite}
                />
              ),
            )}
          </tbody>
        </table>
        </div>
      </div>
      )}

      {/* Long-press Context Menu */}
      <Modal isOpen={!!contextAccount} onClose={() => setContextAccount(null)} maxWidth="sm" className="p-0">
        {contextAccount && (
          <div>
            <div className="px-5 py-4 border-b border-gray-200 dark:border-gray-700">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 truncate">{contextAccount.name}</h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {contextAccount.accountSubType === 'INVESTMENT_BROKERAGE' ? t('contextMenu.subtypeBrokerage') :
                 contextAccount.accountSubType === 'INVESTMENT_CASH' ? t('contextMenu.subtypeInvCash') :
                 formatAccountType(contextAccount.accountType, tc)}
                {contextAccount.isClosed ? t('contextMenu.closedSuffix') : ''}
              </p>
            </div>
            <div className="py-2">
              <button
                onClick={() => { setContextAccount(null); handleViewTransactions(contextAccount); }}
                className="w-full text-left px-5 py-3 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-3"
              >
                <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                </svg>
                {t('row.actions.viewTransactions')}
              </button>
              {!contextAccount.isClosed && (
                <>
                  <button
                    onClick={() => { setContextAccount(null); onEdit(contextAccount); }}
                    className="w-full text-left px-5 py-3 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-3"
                  >
                    <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                    </svg>
                    {t('row.actions.editAccount')}
                  </button>
                  {contextAccount.accountSubType !== 'INVESTMENT_BROKERAGE' && (
                    <button
                      onClick={() => { setContextAccount(null); handleReconcile(contextAccount); }}
                      className="w-full text-left px-5 py-3 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-3"
                    >
                      <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      {t('row.actions.reconcile')}
                    </button>
                  )}
                  <button
                    onClick={() => { setContextAccount(null); handleCloseClick(contextAccount); }}
                    disabled={Number(contextAccount.currentBalance) !== 0}
                    className={`w-full text-left px-5 py-3 text-sm flex items-center gap-3 ${
                      Number(contextAccount.currentBalance) !== 0
                        ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
                        : 'text-orange-600 dark:text-orange-400 hover:bg-gray-100 dark:hover:bg-gray-700'
                    }`}
                  >
                    <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                    </svg>
                    {t('row.actions.closeAccount')}
                    {Number(contextAccount.currentBalance) !== 0 && (
                      <span className="text-xs text-gray-400 dark:text-gray-500 ml-auto">{t('row.actions.balanceMustBeZero')}</span>
                    )}
                  </button>
                </>
              )}
              {contextAccount.isClosed && (
                <button
                  onClick={() => { setContextAccount(null); handleReopen(contextAccount); }}
                  className="w-full text-left px-5 py-3 text-sm text-blue-600 dark:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-3"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  {t('row.actions.reopenAccount')}
                </button>
              )}
              {deletableAccounts.has(contextAccount.id) && (
                <button
                  onClick={() => { setContextAccount(null); handleDeleteClick(contextAccount); }}
                  className="w-full text-left px-5 py-3 text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-3"
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  {t('row.actions.deleteAccount')}
                </button>
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* Close Account Confirmation Dialog */}
      <ConfirmDialog
        isOpen={closeDialogOpen}
        title={t('confirmDialog.closeTitle')}
        message={accountToClose
          ? t('confirmDialog.closeMessage', { name: accountToClose.name })
          : ''
        }
        confirmLabel={isClosing ? t('confirmDialog.closeConfirmLoading') : t('confirmDialog.closeConfirm')}
        cancelLabel={tc('cancel')}
        variant="warning"
        onConfirm={handleCloseConfirm}
        onCancel={handleCloseCancel}
      />

      {/* Delete Account Confirmation Dialog */}
      <ConfirmDialog
        isOpen={deleteDialogOpen}
        title={t('confirmDialog.deleteTitle')}
        message={accountToDelete
          ? t('confirmDialog.deleteMessage', { name: accountToDelete.name })
          : ''
        }
        confirmLabel={isDeleting ? t('confirmDialog.deleteConfirmLoading') : t('confirmDialog.deleteConfirm')}
        cancelLabel={tc('cancel')}
        variant="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
      />
    </div>
  );
}
