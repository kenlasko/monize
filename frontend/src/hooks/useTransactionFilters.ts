'use client';

import { useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { MultiSelectOption } from '@/components/ui/MultiSelect';
import { isInvestmentBrokerageAccount } from '@/lib/account-utils';
import { buildCategoryColorMap } from '@/lib/categoryUtils';
import { Account } from '@/types/account';
import { Category } from '@/types/category';
import { Payee } from '@/types/payee';

// LocalStorage keys for filter persistence
const STORAGE_KEYS = {
  accountIds: 'transactions.filter.accountIds',
  accountStatus: 'transactions.filter.accountStatus',
  categoryIds: 'transactions.filter.categoryIds',
  payeeIds: 'transactions.filter.payeeIds',
  startDate: 'transactions.filter.startDate',
  endDate: 'transactions.filter.endDate',
  search: 'transactions.filter.search',
  timePeriod: 'transactions.filter.timePeriod',
};

// Helper to get filter values as array
// If ANY URL params are present (navigation from reports), ignore localStorage entirely
function getFilterValues(key: string, urlParam: string | null, hasAnyUrlParams: boolean): string[] {
  if (hasAnyUrlParams) {
    return urlParam ? urlParam.split(',').map(s => s.trim()).filter(s => s) : [];
  }
  if (typeof window === 'undefined') return [];
  const stored = localStorage.getItem(key);
  if (!stored) return [];
  try {
    return JSON.parse(stored);
  } catch {
    return [];
  }
}

// Helper to get single string filter value
function getFilterValue(key: string, urlParam: string | null, hasAnyUrlParams: boolean): string {
  if (hasAnyUrlParams) {
    return urlParam || '';
  }
  if (typeof window === 'undefined') return '';
  return localStorage.getItem(key) || '';
}

// Helper to get stored value (for non-URL params like account status)
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

interface UseTransactionFiltersOptions {
  accounts: Account[];
  categories: Category[];
  payees: Payee[];
  weekStartsOn: 0 | 1 | 2 | 3 | 4 | 5 | 6;
}

export function useTransactionFilters({ accounts, categories, payees, weekStartsOn: _weekStartsOn }: UseTransactionFiltersOptions) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Pagination state - initialize from URL
  const [currentPage, setCurrentPage] = useState(() => {
    const pageParam = searchParams.get('page');
    return pageParam ? parseInt(pageParam, 10) : 1;
  });

  // Filters - initialize from URL params, falling back to localStorage
  const [filterAccountIds, setFilterAccountIds] = useState<string[]>([]);
  const [filterAccountStatus, setFilterAccountStatus] = useState<'active' | 'closed' | ''>(() =>
    getStoredValue<'active' | 'closed' | ''>(STORAGE_KEYS.accountStatus, '')
  );
  const [filterCategoryIds, setFilterCategoryIds] = useState<string[]>([]);
  const [filterPayeeIds, setFilterPayeeIds] = useState<string[]>([]);
  const [filterStartDate, setFilterStartDate] = useState<string>('');
  const [filterEndDate, setFilterEndDate] = useState<string>('');
  const [filterSearch, setFilterSearch] = useState<string>('');
  const [searchInput, setSearchInput] = useState<string>('');
  const [filterTimePeriod, setFilterTimePeriod] = useState<string>('');
  const searchDebounceRef = useRef<NodeJS.Timeout | null>(null);
  const [filtersInitialized, setFiltersInitialized] = useState(false);
  const [filtersExpanded, setFiltersExpanded] = useState(true);

  // Track when we're syncing state from browser back/forward navigation
  const syncingFromPopstateRef = useRef(false);

  // Track if this is a filter-triggered change (to reset page to 1)
  const isFilterChange = useRef(false);
  // Target transaction ID for navigating to a specific transaction
  const targetTransactionIdRef = useRef<string | null>(null);
  // Debounce timer for filter-triggered loads
  const filterDebounceRef = useRef<NodeJS.Timeout | null>(null);

  // Update URL when filters or page change
  const updateUrl = useCallback((page: number, filters: {
    accountIds: string[];
    categoryIds: string[];
    payeeIds: string[];
    startDate: string;
    endDate: string;
    search: string;
  }, push: boolean = false) => {
    const params = new URLSearchParams();
    if (page > 1) params.set('page', page.toString());
    if (filters.accountIds.length) params.set('accountIds', filters.accountIds.join(','));
    if (filters.categoryIds.length) params.set('categoryIds', filters.categoryIds.join(','));
    if (filters.payeeIds.length) params.set('payeeIds', filters.payeeIds.join(','));
    if (filters.startDate) params.set('startDate', filters.startDate);
    if (filters.endDate) params.set('endDate', filters.endDate);
    if (filters.search) params.set('search', filters.search);

    const queryString = params.toString();
    const newUrl = queryString ? `/transactions?${queryString}` : '/transactions';
    if (push) {
      router.push(newUrl, { scroll: false });
    } else {
      router.replace(newUrl, { scroll: false });
    }
  }, [router]);

  // Get display info for selected filters
  const selectedCategories = filterCategoryIds.map(id => {
    if (id === 'uncategorized') return { id, name: 'Uncategorized', color: null } as Category;
    if (id === 'transfer') return { id, name: 'Transfers', color: null } as Category;
    return categories.find(c => c.id === id);
  }).filter((c): c is Category => c !== undefined);

  const selectedPayees = filterPayeeIds
    .map(id => payees.find(p => p.id === id))
    .filter((p): p is Payee => p !== undefined);

  const selectedAccounts = filterAccountIds
    .map(id => accounts.find(a => a.id === id))
    .filter((a): a is Account => a !== undefined);

  // Filter accounts by status for the dropdown
  const filteredAccounts = useMemo(() => {
    return accounts.filter(account => {
      if (isInvestmentBrokerageAccount(account)) return false;
      if (filterAccountStatus === 'active') return !account.isClosed;
      if (filterAccountStatus === 'closed') return account.isClosed;
      return true;
    });
  }, [accounts, filterAccountStatus]);

  // Memoize filter option arrays
  const categoryFilterOptions = useMemo(() => {
    const specialOptions: MultiSelectOption[] = [
      { value: 'uncategorized', label: 'Uncategorized' },
      { value: 'transfer', label: 'Transfers' },
    ];
    const buildOptions = (parentId: string | null = null): MultiSelectOption[] => {
      return categories
        .filter(c => c.parentId === parentId)
        .sort((a, b) => a.name.localeCompare(b.name))
        .flatMap(cat => {
          const children = buildOptions(cat.id);
          return [{
            value: cat.id,
            label: cat.name,
            parentId: cat.parentId,
            children: children.length > 0 ? children : undefined,
          }];
        });
    };
    return [...specialOptions, ...buildOptions()];
  }, [categories]);

  const categoryColorMap = useMemo(() => buildCategoryColorMap(categories), [categories]);

  const accountFilterOptions = useMemo(() => {
    return filteredAccounts
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(account => ({ value: account.id, label: account.name }));
  }, [filteredAccounts]);

  const payeeFilterOptions = useMemo(() => {
    return payees
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(payee => ({ value: payee.id, label: payee.name }));
  }, [payees]);

  // When account status filter changes, remove any selected accounts that no longer match
  useEffect(() => {
    if (!filtersInitialized || filterAccountIds.length === 0 || accounts.length === 0) return;
    const filteredIds = new Set(filteredAccounts.map(a => a.id));
    const validSelectedIds = filterAccountIds.filter(id => filteredIds.has(id));
    if (validSelectedIds.length !== filterAccountIds.length) {
      setFilterAccountIds(validSelectedIds); // eslint-disable-line react-hooks/set-state-in-effect -- sync invalid selections after data change
    }
  }, [filterAccountStatus, filteredAccounts, filtersInitialized, accounts.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // When payees change, remove any selected payee filter IDs that no longer exist
  useEffect(() => {
    if (!filtersInitialized || filterPayeeIds.length === 0 || payees.length === 0) return;
    const payeeIds = new Set(payees.map(p => p.id));
    const validSelectedIds = filterPayeeIds.filter(id => payeeIds.has(id));
    if (validSelectedIds.length !== filterPayeeIds.length) {
      setFilterPayeeIds(validSelectedIds); // eslint-disable-line react-hooks/set-state-in-effect -- sync invalid selections after data change
    }
  }, [payees, filtersInitialized]); // eslint-disable-line react-hooks/exhaustive-deps

  // When categories change, remove any selected category filter IDs that no longer exist
  useEffect(() => {
    if (!filtersInitialized || filterCategoryIds.length === 0 || categories.length === 0) return;
    const specialIds = new Set(['uncategorized', 'transfer']);
    const categoryIds = new Set(categories.map(c => c.id));
    const validSelectedIds = filterCategoryIds.filter(id => specialIds.has(id) || categoryIds.has(id));
    if (validSelectedIds.length !== filterCategoryIds.length) {
      setFilterCategoryIds(validSelectedIds); // eslint-disable-line react-hooks/set-state-in-effect -- sync invalid selections after data change
    }
  }, [categories, filtersInitialized]); // eslint-disable-line react-hooks/exhaustive-deps

  // Calculate active filter count
  const activeFilterCount = useMemo(() => {
    let count = 0;
    count += filterAccountIds.length;
    count += filterCategoryIds.length;
    count += filterPayeeIds.length;
    if (filterStartDate) count++;
    if (filterEndDate) count++;
    if (filterSearch) count++;
    return count;
  }, [filterAccountIds, filterCategoryIds, filterPayeeIds, filterStartDate, filterEndDate, filterSearch]);

  // Auto-collapse filters when there are active filters, expand when none
  useEffect(() => {
    if (filtersInitialized) {
      setFiltersExpanded(activeFilterCount === 0); // eslint-disable-line react-hooks/set-state-in-effect -- set once on init
    }
  }, [filtersInitialized]); // eslint-disable-line react-hooks/exhaustive-deps

  // Initialize filters on mount
  /* eslint-disable react-hooks/set-state-in-effect -- mount-time initialization from URL/localStorage */
  useEffect(() => {
    const hasAnyUrlParams = searchParams.has('accountId') ||
      searchParams.has('accountIds') ||
      searchParams.has('categoryId') ||
      searchParams.has('categoryIds') ||
      searchParams.has('payeeId') ||
      searchParams.has('payeeIds') ||
      searchParams.has('startDate') ||
      searchParams.has('endDate') ||
      searchParams.has('search');

    const getAccountIds = () => {
      const ids = searchParams.get('accountIds');
      const id = searchParams.get('accountId');
      return getFilterValues(STORAGE_KEYS.accountIds, ids || id, hasAnyUrlParams);
    };
    const getCategoryIds = () => {
      const ids = searchParams.get('categoryIds');
      const id = searchParams.get('categoryId');
      return getFilterValues(STORAGE_KEYS.categoryIds, ids || id, hasAnyUrlParams);
    };
    const getPayeeIds = () => {
      const ids = searchParams.get('payeeIds');
      const id = searchParams.get('payeeId');
      return getFilterValues(STORAGE_KEYS.payeeIds, ids || id, hasAnyUrlParams);
    };

    setFilterAccountIds(getAccountIds());
    setFilterCategoryIds(getCategoryIds());
    setFilterPayeeIds(getPayeeIds());
    const initialStartDate = getFilterValue(STORAGE_KEYS.startDate, searchParams.get('startDate'), hasAnyUrlParams);
    const initialEndDate = getFilterValue(STORAGE_KEYS.endDate, searchParams.get('endDate'), hasAnyUrlParams);
    setFilterStartDate(initialStartDate);
    setFilterEndDate(initialEndDate);
    const initialSearch = getFilterValue(STORAGE_KEYS.search, searchParams.get('search'), hasAnyUrlParams);
    setFilterSearch(initialSearch);
    setSearchInput(initialSearch);
    if (hasAnyUrlParams) {
      setFilterTimePeriod((initialStartDate || initialEndDate) ? 'custom' : '');
    } else {
      setFilterTimePeriod(getFilterValue(STORAGE_KEYS.timePeriod, null, false));
    }
    setFiltersInitialized(true);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  /* eslint-enable react-hooks/set-state-in-effect */

  // Persist filter changes to localStorage
  useEffect(() => {
    localStorage.setItem(STORAGE_KEYS.accountStatus, JSON.stringify(filterAccountStatus));
  }, [filterAccountStatus]);

  useEffect(() => {
    if (!filtersInitialized) return;
    localStorage.setItem(STORAGE_KEYS.accountIds, JSON.stringify(filterAccountIds));
    localStorage.setItem(STORAGE_KEYS.categoryIds, JSON.stringify(filterCategoryIds));
    localStorage.setItem(STORAGE_KEYS.payeeIds, JSON.stringify(filterPayeeIds));
    localStorage.setItem(STORAGE_KEYS.startDate, filterStartDate);
    localStorage.setItem(STORAGE_KEYS.endDate, filterEndDate);
    localStorage.setItem(STORAGE_KEYS.search, filterSearch);
    localStorage.setItem(STORAGE_KEYS.timePeriod, filterTimePeriod);
  }, [filterAccountIds, filterCategoryIds, filterPayeeIds, filterStartDate, filterEndDate, filterSearch, filterTimePeriod, filtersInitialized]);

  // Helper to update array filter and mark as filter change
  const handleArrayFilterChange = useCallback(<T,>(setter: (value: T) => void, value: T) => {
    isFilterChange.current = true;
    setter(value);
  }, []);

  // Helper to update string filter and mark as filter change
  const handleFilterChange = useCallback((setter: (value: string) => void, value: string) => {
    isFilterChange.current = true;
    setter(value);
  }, []);

  // Debounced search handler
  const handleSearchChange = useCallback((value: string) => {
    setSearchInput(value);
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    searchDebounceRef.current = setTimeout(() => {
      isFilterChange.current = true;
      setFilterSearch(value);
    }, 300);
  }, []);

  // Cleanup debounce timers on unmount
  useEffect(() => {
    const searchRef = searchDebounceRef;
    const filterRef = filterDebounceRef;
    return () => {
      if (searchRef.current) clearTimeout(searchRef.current);
      if (filterRef.current) clearTimeout(filterRef.current);
    };
  }, []);

  // Re-sync filter state when browser back/forward is pressed
  useEffect(() => {
    const handlePopstate = () => {
      const params = new URLSearchParams(window.location.search);
      syncingFromPopstateRef.current = true;

      setFilterAccountIds(params.get('accountIds')?.split(',').filter(Boolean) || []);
      setFilterCategoryIds(params.get('categoryIds')?.split(',').filter(Boolean) || []);
      setFilterPayeeIds(params.get('payeeIds')?.split(',').filter(Boolean) || []);
      setFilterStartDate(params.get('startDate') || '');
      setFilterEndDate(params.get('endDate') || '');
      const search = params.get('search') || '';
      setFilterSearch(search);
      setSearchInput(search);
      const hasDateParams = params.has('startDate') || params.has('endDate');
      setFilterTimePeriod(hasDateParams ? 'custom' : '');
      const pageParam = params.get('page');
      setCurrentPage(pageParam ? parseInt(pageParam, 10) : 1);
    };

    window.addEventListener('popstate', handlePopstate);
    return () => window.removeEventListener('popstate', handlePopstate);
  }, []);

  const handleCategoryClick = useCallback((categoryId: string) => {
    isFilterChange.current = true;
    setFilterAccountIds([]);
    setFilterAccountStatus('');
    setFilterCategoryIds([categoryId]);
  }, []);

  const handleDateFilterClick = useCallback((date: string) => {
    isFilterChange.current = true;
    setFilterStartDate(date);
    setFilterEndDate(date);
    setFilterTimePeriod('custom');
  }, []);

  const handleAccountFilterClick = useCallback((accountId: string) => {
    isFilterChange.current = true;
    setFilterAccountStatus('');
    setFilterAccountIds([accountId]);
  }, []);

  const handlePayeeFilterClick = useCallback((payeeId: string) => {
    isFilterChange.current = true;
    setFilterPayeeIds([payeeId]);
  }, []);

  const handleTransferClick = useCallback((linkedAccountId: string, _linkedTransactionId: string) => {
    targetTransactionIdRef.current = _linkedTransactionId;
    setFilterAccountStatus('');
    isFilterChange.current = true;
    setFilterAccountIds([linkedAccountId]);
  }, []);

  const clearFilters = useCallback(() => {
    setCurrentPage(1);
    setFilterAccountIds([]);
    setFilterCategoryIds([]);
    setFilterPayeeIds([]);
    setFilterStartDate('');
    setFilterEndDate('');
    setFilterSearch('');
    setFilterTimePeriod('');
    localStorage.removeItem(STORAGE_KEYS.accountIds);
    localStorage.removeItem(STORAGE_KEYS.categoryIds);
    localStorage.removeItem(STORAGE_KEYS.payeeIds);
    localStorage.removeItem(STORAGE_KEYS.startDate);
    localStorage.removeItem(STORAGE_KEYS.endDate);
    localStorage.removeItem(STORAGE_KEYS.search);
    localStorage.removeItem(STORAGE_KEYS.timePeriod);
    router.replace('/transactions', { scroll: false });
  }, [router]);

  const goToPage = useCallback((page: number) => {
    setCurrentPage(page);
  }, []);

  return {
    // Pagination
    currentPage, setCurrentPage,

    // Filter state
    filterAccountIds, setFilterAccountIds,
    filterAccountStatus, setFilterAccountStatus,
    filterCategoryIds, setFilterCategoryIds,
    filterPayeeIds, setFilterPayeeIds,
    filterStartDate, setFilterStartDate,
    filterEndDate, setFilterEndDate,
    filterSearch, setFilterSearch,
    searchInput,
    filterTimePeriod, setFilterTimePeriod,
    filtersInitialized,
    filtersExpanded, setFiltersExpanded,
    activeFilterCount,

    // Derived filter data
    filteredAccounts,
    selectedAccounts,
    selectedCategories,
    selectedPayees,

    // Filter options
    accountFilterOptions,
    categoryFilterOptions,
    payeeFilterOptions,
    categoryColorMap,

    // Filter handlers
    handleArrayFilterChange,
    handleFilterChange,
    handleSearchChange,
    handleCategoryClick,
    handleDateFilterClick,
    handleAccountFilterClick,
    handlePayeeFilterClick,
    handleTransferClick,
    clearFilters,
    goToPage,

    // URL sync internals (needed by the page component)
    updateUrl,
    isFilterChange,
    syncingFromPopstateRef,
    filterDebounceRef,
    targetTransactionIdRef,
  };
}
