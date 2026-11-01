import { useMemo, useCallback } from 'react';
import {
  BillsFilterState,
  BillsTypeFilter,
  countActiveBillsFilters,
} from '@/lib/bills-filters';
import { useLocalStorage } from '@/hooks/useLocalStorage';

const STORAGE_KEYS = {
  filterType: 'monize-bills-filter-type',
  nameSearch: 'monize-bills-name-search',
  payeeIds: 'monize-bills-payee-ids',
  accountIds: 'monize-bills-account-ids',
  categoryIds: 'monize-bills-category-ids',
  filtersExpanded: 'monize-bills-filters-expanded',
} as const;

/**
 * State management for the Bills & Deposits filter panel. Mirrors the
 * useTransactionFilters pattern: derived active count and a clear helper.
 * Filter selections persist to localStorage so they survive page reloads.
 */
export function useBillsFilters() {
  // The All / Bills / Deposits choice sits inside the folding panel with the
  // other filters, so it is counted, chipped and cleared with them: a filter
  // folded out of sight that still narrowed the list would be one the reader
  // forgets is applied.
  const [filterType, setFilterType] = useLocalStorage<BillsTypeFilter>(
    STORAGE_KEYS.filterType,
    'all',
  );
  const [nameSearch, setNameSearch] = useLocalStorage(
    STORAGE_KEYS.nameSearch,
    '',
  );
  const [selectedPayeeIds, setSelectedPayeeIds] = useLocalStorage<string[]>(
    STORAGE_KEYS.payeeIds,
    [],
  );
  const [selectedAccountIds, setSelectedAccountIds] = useLocalStorage<string[]>(
    STORAGE_KEYS.accountIds,
    [],
  );
  const [selectedCategoryIds, setSelectedCategoryIds] = useLocalStorage<
    string[]
  >(STORAGE_KEYS.categoryIds, []);
  const [filtersExpanded, setFiltersExpanded] = useLocalStorage(
    STORAGE_KEYS.filtersExpanded,
    false,
  );

  const filterState: BillsFilterState = useMemo(
    () => ({
      nameSearch,
      selectedPayeeIds,
      selectedAccountIds,
      selectedCategoryIds,
    }),
    [nameSearch, selectedPayeeIds, selectedAccountIds, selectedCategoryIds],
  );

  const activeFilterCount = useMemo(
    () => countActiveBillsFilters(filterState) + (filterType === 'all' ? 0 : 1),
    [filterState, filterType],
  );

  const clearFilters = useCallback(() => {
    setFilterType('all');
    setNameSearch('');
    setSelectedPayeeIds([]);
    setSelectedAccountIds([]);
    setSelectedCategoryIds([]);
  }, [
    setFilterType,
    setNameSearch,
    setSelectedPayeeIds,
    setSelectedAccountIds,
    setSelectedCategoryIds,
  ]);

  return {
    filterType,
    setFilterType,
    nameSearch,
    setNameSearch,
    selectedPayeeIds,
    setSelectedPayeeIds,
    selectedAccountIds,
    setSelectedAccountIds,
    selectedCategoryIds,
    setSelectedCategoryIds,
    filtersExpanded,
    setFiltersExpanded,
    filterState,
    activeFilterCount,
    clearFilters,
  };
}
