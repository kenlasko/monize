'use client';

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Account, AccountType } from '@/types/account';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Modal } from '@/components/ui/Modal';
import { accountsApi } from '@/lib/accounts';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import toast from 'react-hot-toast';

type SortField = 'name' | 'type' | 'balance' | 'status';
type SortDirection = 'asc' | 'desc';
type DensityLevel = 'normal' | 'compact' | 'dense';

// LocalStorage keys for filter persistence
const STORAGE_KEYS = {
  showFilters: 'accounts.filter.showFilters',
  accountType: 'accounts.filter.accountType',
  status: 'accounts.filter.status',
  sortField: 'accounts.filter.sortField',
  sortDirection: 'accounts.filter.sortDirection',
  density: 'accounts.filter.density',
};

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

interface AccountListProps {
  accounts: Account[];
  brokerageMarketValues?: Map<string, number>;
  onEdit: (account: Account) => void;
  onRefresh: () => void;
}

export function AccountList({ accounts, brokerageMarketValues, onEdit, onRefresh }: AccountListProps) {
  const router = useRouter();
  const { formatCurrency: formatCurrencyBase } = useNumberFormat();
  const { convertToDefault, defaultCurrency } = useExchangeRates();
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [accountToClose, setAccountToClose] = useState<Account | null>(null);
  const [accountToDelete, setAccountToDelete] = useState<Account | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
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
  const [filterAccountType, setFilterAccountType] = useState<AccountType | ''>(() =>
    getStoredValue<AccountType | ''>(STORAGE_KEYS.accountType, '')
  );
  const [filterStatus, setFilterStatus] = useState<'active' | 'closed' | ''>(() =>
    getStoredValue<'active' | 'closed' | ''>(STORAGE_KEYS.status, '')
  );

  // Density state - initialize from localStorage
  const [density, setDensity] = useState<DensityLevel>(() =>
    getStoredValue<DensityLevel>(STORAGE_KEYS.density, 'normal')
  );

  // Persist filter/sort changes to localStorage
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.showFilters, JSON.stringify(showFilters));
  }, [showFilters]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.accountType, JSON.stringify(filterAccountType));
  }, [filterAccountType]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.status, JSON.stringify(filterStatus));
  }, [filterStatus]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.sortField, JSON.stringify(sortField));
  }, [sortField]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.sortDirection, JSON.stringify(sortDirection));
  }, [sortDirection]);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.density, JSON.stringify(density));
  }, [density]);

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
      router.push('/investments');
    } else {
      router.push(`/transactions?accountId=${account.id}`);
    }
  }, [router]);

  // Memoize padding classes based on density
  const cellPadding = useMemo(() => {
    switch (density) {
      case 'dense': return 'px-3 py-1';
      case 'compact': return 'px-4 py-2';
      default: return 'px-6 py-4';
    }
  }, [density]);

  const headerPadding = useMemo(() => {
    switch (density) {
      case 'dense': return 'px-3 py-2';
      case 'compact': return 'px-4 py-2';
      default: return 'px-6 py-3';
    }
  }, [density]);

  const cycleDensity = useCallback(() => {
    setDensity(prev => prev === 'normal' ? 'compact' : prev === 'compact' ? 'dense' : 'normal');
  }, []);

  // Get unique account types from the accounts
  const availableAccountTypes = useMemo(() => {
    const types = new Set<AccountType>();
    accounts.forEach((a) => types.add(a.accountType));
    return Array.from(types).sort();
  }, [accounts]);

  // Filter and sort accounts
  const filteredAndSortedAccounts = useMemo(() => {
    let result = [...accounts];

    // Apply filters
    if (filterAccountType) {
      result = result.filter((a) => a.accountType === filterAccountType);
    }
    if (filterStatus) {
      result = result.filter((a) =>
        filterStatus === 'active' ? !a.isClosed : a.isClosed
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
          comparison = Number(a.currentBalance) - Number(b.currentBalance);
          break;
        case 'status':
          comparison = (a.isClosed ? 1 : 0) - (b.isClosed ? 1 : 0);
          break;
      }
      return sortDirection === 'asc' ? comparison : -comparison;
    });

    return result;
  }, [accounts, filterAccountType, filterStatus, sortField, sortDirection]);

  // Build a map of account IDs to names for showing linked account pairs
  const accountNameMap = useMemo(() => {
    const map = new Map<string, string>();
    accounts.forEach((a) => map.set(a.id, a.name));
    return map;
  }, [accounts]);

  // Count active filters
  const activeFilterCount = [filterAccountType, filterStatus].filter(Boolean).length;

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('asc');
    }
  };

  const clearFilters = () => {
    setFilterAccountType('');
    setFilterStatus('');
    // Also clear localStorage
    localStorage.removeItem(STORAGE_KEYS.accountType);
    localStorage.removeItem(STORAGE_KEYS.status);
  };

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) {
      return <span className="ml-1 text-gray-300 dark:text-gray-600">↕</span>;
    }
    return <span className="ml-1">{sortDirection === 'asc' ? '↑' : '↓'}</span>;
  };

  const handleViewTransactions = (account: Account) => {
    if (account.accountSubType === 'INVESTMENT_BROKERAGE') {
      router.push('/investments');
    } else {
      router.push(`/transactions?accountId=${account.id}`);
    }
  };

  const handleReconcile = (account: Account) => {
    router.push(`/reconcile?accountId=${account.id}`);
  };

  const handleCloseClick = (account: Account) => {
    setAccountToClose(account);
    setCloseDialogOpen(true);
  };

  const handleDeleteClick = (account: Account) => {
    setAccountToDelete(account);
    setDeleteDialogOpen(true);
  };

  const handleDeleteConfirm = async () => {
    if (!accountToDelete) return;

    setIsDeleting(true);
    try {
      await accountsApi.delete(accountToDelete.id);
      toast.success('Account deleted successfully');
      setDeleteDialogOpen(false);
      setAccountToDelete(null);
      onRefresh();
    } catch (error: any) {
      const message = error.response?.data?.message || 'Failed to delete account';
      toast.error(message);
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
      toast.success('Account closed successfully');
      setCloseDialogOpen(false);
      setAccountToClose(null);
      onRefresh();
    } catch (error: any) {
      const message = error.response?.data?.message || 'Failed to close account';
      toast.error(message);
    } finally {
      setIsClosing(false);
    }
  };

  const handleCloseCancel = () => {
    setCloseDialogOpen(false);
    setAccountToClose(null);
  };

  const handleReopen = async (account: Account) => {
    try {
      await accountsApi.reopen(account.id);
      toast.success('Account reopened successfully');
      onRefresh();
    } catch (error: any) {
      const message = error.response?.data?.message || 'Failed to reopen account';
      toast.error(message);
    }
  };

  const formatCurrency = (amount: number | string | null | undefined, currency: string) => {
    const numericAmount = Number(amount) || 0;
    const formatted = formatCurrencyBase(numericAmount, currency);

    // Only show currency code if it differs from user's default currency
    if (currency !== defaultCurrency) {
      return `${formatted} ${currency}`;
    }
    return formatted;
  };

  const formatAccountType = (type: AccountType) => {
    const labels: Record<AccountType, string> = {
      CHEQUING: 'Chequing',
      SAVINGS: 'Savings',
      CREDIT_CARD: 'Credit Card',
      INVESTMENT: 'Investment',
      LOAN: 'Loan',
      MORTGAGE: 'Mortgage',
      CASH: 'Cash',
      LINE_OF_CREDIT: 'Line of Credit',
      ASSET: 'Asset',
      OTHER: 'Other',
    };
    return labels[type] || type;
  };

  const getAccountTypeColor = (type: AccountType) => {
    switch (type) {
      case 'CHEQUING':
        return 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200';
      case 'SAVINGS':
        return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200';
      case 'CREDIT_CARD':
        return 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200';
      case 'INVESTMENT':
        return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200';
      case 'LOAN':
        return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200';
      case 'MORTGAGE':
        return 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200';
      case 'CASH':
        return 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200';
      case 'LINE_OF_CREDIT':
        return 'bg-rose-100 text-rose-800 dark:bg-rose-900 dark:text-rose-200';
      case 'ASSET':
        return 'bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200';
      default:
        return 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200';
    }
  };

  if (accounts.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500 dark:text-gray-400">No accounts found. Create your first account to get started!</p>
      </div>
    );
  }

  return (
    <div>
      {/* Filter Bar */}
      <div className="px-6 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div className="flex items-center gap-4">
            {/* Type dropdown and Status segmented control - grouped together */}
            <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2 sm:gap-3">
              <select
                value={filterAccountType}
                onChange={(e) => setFilterAccountType(e.target.value as AccountType | '')}
                className="text-sm font-sans border border-gray-300 dark:border-gray-600 rounded-md px-3 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              >
                <option value="">All Types</option>
                {availableAccountTypes.map((type) => (
                  <option key={type} value={type}>{formatAccountType(type)}</option>
                ))}
              </select>

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
                All
              </button>
              <button
                onClick={() => setFilterStatus('active')}
                className={`px-3 py-1.5 text-sm font-medium border-t border-b ${
                  filterStatus === 'active'
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
                }`}
              >
                Active
              </button>
              <button
                onClick={() => setFilterStatus('closed')}
                className={`px-3 py-1.5 text-sm font-medium rounded-r-md border ${
                  filterStatus === 'closed'
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
                }`}
              >
                Closed
              </button>
              </div>
            </div>

            {activeFilterCount > 0 && (
              <button onClick={clearFilters} className="text-sm text-blue-600 dark:text-blue-400 hover:underline">
                Clear
              </button>
            )}
          </div>
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {filteredAndSortedAccounts.length} of {accounts.length} accounts
          </span>
        </div>
      </div>

      {filteredAndSortedAccounts.length === 0 ? (
        <div className="text-center py-12">
          <p className="text-gray-500 dark:text-gray-400">No accounts match your filters.</p>
          <button
            onClick={clearFilters}
            className="mt-2 text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
          >
            Clear Filters
          </button>
        </div>
      ) : (
      <div>
        {/* Density toggle */}
        <div className="flex justify-end p-2 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
          <button
            onClick={cycleDensity}
            className="inline-flex items-center px-2 py-1 text-xs font-medium text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
            title="Toggle row density"
          >
            <svg className="w-4 h-4 mr-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
            {density === 'normal' ? 'Normal' : density === 'compact' ? 'Compact' : 'Dense'}
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
                  Account Name
                  <SortIcon field="name" />
                </div>
              </th>
              <th
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none hidden sm:table-cell`}
                onClick={() => handleSort('type')}
              >
                <div className="flex items-center">
                  Type
                  <SortIcon field="type" />
                </div>
              </th>
              <th
                className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none`}
                onClick={() => handleSort('balance')}
              >
                <div className="flex items-center justify-end">
                  Balance
                  <SortIcon field="balance" />
                </div>
              </th>
              <th
                className={`${headerPadding} text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 select-none hidden md:table-cell`}
                onClick={() => handleSort('status')}
              >
                <div className="flex items-center">
                  Status
                  <SortIcon field="status" />
                </div>
              </th>
              <th className={`${headerPadding} text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider hidden min-[480px]:table-cell`}>
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-900 divide-y divide-gray-200 dark:divide-gray-700">
            {filteredAndSortedAccounts.map((account) => (
            <tr
              key={account.id}
              className="hover:bg-gray-50 dark:hover:bg-gray-800 cursor-pointer select-none"
              onClick={() => handleRowClick(account)}
              onMouseDown={() => handleLongPressStart(account)}
              onMouseUp={handleLongPressEnd}
              onMouseLeave={handleLongPressEnd}
              onTouchStart={(e) => handleLongPressStart(account, e)}
              onTouchMove={handleTouchMove}
              onTouchEnd={handleLongPressEnd}
              onTouchCancel={handleLongPressEnd}
            >
              <td className={`${cellPadding} ${account.isClosed ? 'opacity-50' : ''} max-w-[50vw] sm:max-w-[180px] md:max-w-none`}>
                <div
                  className="text-left w-full"
                  title={account.linkedAccountId && (account.accountSubType === 'INVESTMENT_CASH' || account.accountSubType === 'INVESTMENT_BROKERAGE')
                    ? `${account.name} — Paired with ${accountNameMap.get(account.linkedAccountId) || 'linked account'}`
                    : account.name}
                >
                  <div className="flex items-center text-sm font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300">
                    {account.isFavourite && (
                      <svg
                        className="w-4 h-4 mr-1 flex-shrink-0 text-yellow-500"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                        aria-label="Favourite"
                      >
                        <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                      </svg>
                    )}
                    <span className="truncate">{account.name}</span>
                    {density !== 'normal' && account.linkedAccountId && (account.accountSubType === 'INVESTMENT_CASH' || account.accountSubType === 'INVESTMENT_BROKERAGE') && (
                      <svg className="w-3.5 h-3.5 ml-1 flex-shrink-0 text-gray-400 dark:text-gray-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                      </svg>
                    )}
                  </div>
                  {density === 'normal' && account.linkedAccountId && (account.accountSubType === 'INVESTMENT_CASH' || account.accountSubType === 'INVESTMENT_BROKERAGE') && (
                    <div className="text-xs text-gray-400 dark:text-gray-500 truncate flex items-center gap-1">
                      <svg className="w-3 h-3 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                      </svg>
                      Paired with {accountNameMap.get(account.linkedAccountId) || 'linked account'}
                    </div>
                  )}
                  {density === 'normal' && account.description && !account.linkedAccountId && (
                    <div className="text-sm text-gray-500 dark:text-gray-400 truncate">{account.description}</div>
                  )}
                </div>
              </td>
              <td className={`${cellPadding} whitespace-nowrap ${account.isClosed ? 'opacity-50' : ''} hidden sm:table-cell`}>
                <span
                  className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${getAccountTypeColor(
                    account.accountType
                  )}`}
                >
                  {account.accountSubType === 'INVESTMENT_BROKERAGE' ? 'Brokerage' :
                   account.accountSubType === 'INVESTMENT_CASH' ? 'Inv. Cash' :
                   formatAccountType(account.accountType)}
                </span>
              </td>
              <td className={`${cellPadding} whitespace-nowrap text-right ${account.isClosed ? 'opacity-50' : ''}`}>
                {account.accountSubType === 'INVESTMENT_BROKERAGE' && brokerageMarketValues?.has(account.id) ? (
                  <>
                    <div className="text-sm font-medium text-green-600 dark:text-green-400">
                      {formatCurrency(brokerageMarketValues.get(account.id)!, account.currencyCode)}
                    </div>
                    {density === 'normal' && (
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        Market value
                      </div>
                    )}
                    {density !== 'dense' && account.currencyCode !== defaultCurrency && (
                      <div className="text-xs text-gray-400 dark:text-gray-500">
                        {'\u2248 '}{formatCurrencyBase(convertToDefault(brokerageMarketValues.get(account.id)!, account.currencyCode), defaultCurrency)}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div
                      className={`text-sm font-medium ${
                        Number(account.currentBalance) >= 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'
                      }`}
                    >
                      {formatCurrency(account.currentBalance, account.currencyCode)}
                    </div>
                    {density !== 'dense' && account.currencyCode !== defaultCurrency && (
                      <div className="text-xs text-gray-400 dark:text-gray-500">
                        {'\u2248 '}{formatCurrencyBase(convertToDefault(Number(account.currentBalance) || 0, account.currencyCode), defaultCurrency)}
                      </div>
                    )}
                    {density !== 'dense' && account.creditLimit && (
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        Limit: {formatCurrency(account.creditLimit, account.currencyCode)}
                      </div>
                    )}
                  </>
                )}
              </td>
              <td className={`${cellPadding} whitespace-nowrap hidden md:table-cell`}>
                <span
                  className={`px-2 inline-flex text-xs leading-5 font-semibold rounded-full ${
                    !account.isClosed
                      ? 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200'
                      : 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300'
                  }`}
                >
                  {!account.isClosed ? 'Active' : 'Closed'}
                </span>
              </td>
              <td className={`${cellPadding} whitespace-nowrap text-right text-sm font-medium ${density === 'dense' ? 'space-x-1' : 'space-x-2'} hidden min-[480px]:table-cell`} onClick={(e) => e.stopPropagation()}>
                {!account.isClosed ? (
                  <>
                    {density === 'dense' ? (
                      <>
                        <button
                          onClick={() => onEdit(account)}
                          className="inline-flex items-center justify-center p-1.5 text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
                          title="Edit"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                          </svg>
                        </button>
                        {account.accountSubType !== 'INVESTMENT_BROKERAGE' && (
                          <button
                            onClick={() => handleReconcile(account)}
                            className="inline-flex items-center justify-center p-1.5 text-gray-600 dark:text-gray-300 hover:text-green-600 dark:hover:text-green-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
                            title="Reconcile"
                          >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                            </svg>
                          </button>
                        )}
                        <button
                          onClick={() => handleCloseClick(account)}
                          disabled={Number(account.currentBalance) !== 0}
                          className={`inline-flex items-center justify-center p-1.5 rounded ${
                            Number(account.currentBalance) !== 0
                              ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed'
                              : 'text-gray-600 dark:text-gray-300 hover:text-orange-600 dark:hover:text-orange-400 hover:bg-gray-100 dark:hover:bg-gray-700'
                          }`}
                          title={Number(account.currentBalance) !== 0 ? 'Account must have zero balance to close' : 'Close account'}
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 8h14M5 8a2 2 0 110-4h14a2 2 0 110 4M5 8v10a2 2 0 002 2h10a2 2 0 002-2V8m-9 4h4" />
                          </svg>
                        </button>
                        {deletableAccounts.has(account.id) && (
                          <button
                            onClick={() => handleDeleteClick(account)}
                            className="inline-flex items-center justify-center p-1.5 text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30 rounded"
                            title="Permanently delete account (no transactions)"
                          >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => onEdit(account)}
                        >
                          Edit
                        </Button>
                        {account.accountSubType !== 'INVESTMENT_BROKERAGE' && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleReconcile(account)}
                            title="Reconcile account against a statement"
                          >
                            Reconcile
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleCloseClick(account)}
                          disabled={Number(account.currentBalance) !== 0}
                          title={Number(account.currentBalance) !== 0 ? 'Account must have zero balance to close' : 'Close account'}
                        >
                          Close
                        </Button>
                        {deletableAccounts.has(account.id) && (
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => handleDeleteClick(account)}
                            title="Permanently delete account (no transactions)"
                          >
                            Delete
                          </Button>
                        )}
                      </>
                    )}
                  </>
                ) : (
                  <>
                    {density === 'dense' ? (
                      <>
                        <button
                          onClick={() => handleReopen(account)}
                          className="inline-flex items-center justify-center p-1.5 text-gray-600 dark:text-gray-300 hover:text-blue-600 dark:hover:text-blue-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded"
                          title="Reopen"
                        >
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                          </svg>
                        </button>
                        {deletableAccounts.has(account.id) && (
                          <button
                            onClick={() => handleDeleteClick(account)}
                            className="inline-flex items-center justify-center p-1.5 text-red-600 dark:text-red-400 hover:text-red-700 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-900/30 rounded"
                            title="Permanently delete account (no transactions)"
                          >
                            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleReopen(account)}
                        >
                          Reopen
                        </Button>
                        {deletableAccounts.has(account.id) && (
                          <Button
                            variant="danger"
                            size="sm"
                            onClick={() => handleDeleteClick(account)}
                            title="Permanently delete account (no transactions)"
                          >
                            Delete
                          </Button>
                        )}
                      </>
                    )}
                  </>
                )}
              </td>
            </tr>
            ))}
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
                {contextAccount.accountSubType === 'INVESTMENT_BROKERAGE' ? 'Brokerage' :
                 contextAccount.accountSubType === 'INVESTMENT_CASH' ? 'Inv. Cash' :
                 formatAccountType(contextAccount.accountType)}
                {contextAccount.isClosed ? ' — Closed' : ''}
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
                View Transactions
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
                    Edit Account
                  </button>
                  {contextAccount.accountSubType !== 'INVESTMENT_BROKERAGE' && (
                    <button
                      onClick={() => { setContextAccount(null); handleReconcile(contextAccount); }}
                      className="w-full text-left px-5 py-3 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center gap-3"
                    >
                      <svg className="w-5 h-5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      Reconcile
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
                    Close Account
                    {Number(contextAccount.currentBalance) !== 0 && (
                      <span className="text-xs text-gray-400 dark:text-gray-500 ml-auto">Balance must be zero</span>
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
                  Reopen Account
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
                  Delete Account
                </button>
              )}
            </div>
          </div>
        )}
      </Modal>

      {/* Close Account Confirmation Dialog */}
      <ConfirmDialog
        isOpen={closeDialogOpen}
        title="Close Account"
        message={accountToClose
          ? `Are you sure you want to close "${accountToClose.name}"? The account must have a zero balance to be closed.`
          : ''
        }
        confirmLabel={isClosing ? 'Closing...' : 'Close Account'}
        cancelLabel="Cancel"
        variant="warning"
        onConfirm={handleCloseConfirm}
        onCancel={handleCloseCancel}
      />

      {/* Delete Account Confirmation Dialog */}
      <ConfirmDialog
        isOpen={deleteDialogOpen}
        title="Delete Account"
        message={accountToDelete
          ? `Are you sure you want to permanently delete "${accountToDelete.name}"? This action cannot be undone.`
          : ''
        }
        confirmLabel={isDeleting ? 'Deleting...' : 'Delete Account'}
        cancelLabel="Cancel"
        variant="danger"
        onConfirm={handleDeleteConfirm}
        onCancel={handleDeleteCancel}
      />
    </div>
  );
}
