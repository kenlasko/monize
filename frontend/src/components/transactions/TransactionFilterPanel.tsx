'use client';

import { MultiSelect, MultiSelectOption } from '@/components/ui/MultiSelect';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Account } from '@/types/account';
import { Category } from '@/types/category';
import { Payee } from '@/types/payee';
import { TimePeriod, TIME_PERIOD_OPTIONS, resolveTimePeriod } from '@/lib/time-periods';

interface TransactionFilterPanelProps {
  filterAccountIds: string[];
  filterCategoryIds: string[];
  filterPayeeIds: string[];
  filterStartDate: string;
  filterEndDate: string;
  filterSearch: string;
  searchInput: string;
  filterAccountStatus: 'active' | 'closed' | '';
  filterTimePeriod: string;
  weekStartsOn: 0 | 1 | 2 | 3 | 4 | 5 | 6;
  handleArrayFilterChange: <T>(setter: (value: T) => void, value: T) => void;
  handleFilterChange: (setter: (value: string) => void, value: string) => void;
  handleSearchChange: (value: string) => void;
  setFilterAccountStatus: (value: 'active' | 'closed' | '') => void;
  setFilterAccountIds: (value: string[]) => void;
  setFilterCategoryIds: (value: string[]) => void;
  setFilterPayeeIds: (value: string[]) => void;
  setFilterStartDate: (value: string) => void;
  setFilterEndDate: (value: string) => void;
  setFilterSearch: (value: string) => void;
  setFilterTimePeriod: (value: string) => void;
  filtersExpanded: boolean;
  setFiltersExpanded: (value: boolean) => void;
  activeFilterCount: number;
  filteredAccounts: Account[];
  selectedAccounts: Account[];
  selectedCategories: Category[];
  selectedPayees: Payee[];
  accountFilterOptions: MultiSelectOption[];
  categoryFilterOptions: MultiSelectOption[];
  payeeFilterOptions: MultiSelectOption[];
  formatDate: (date: string) => string;
  onClearFilters: () => void;
  bulkSelectMode?: boolean;
  onToggleBulkSelectMode?: () => void;
}

export function TransactionFilterPanel({
  filterAccountIds,
  filterCategoryIds,
  filterPayeeIds,
  filterStartDate,
  filterEndDate,
  filterSearch,
  searchInput,
  filterAccountStatus,
  filterTimePeriod,
  weekStartsOn,
  handleArrayFilterChange,
  handleFilterChange,
  handleSearchChange,
  setFilterAccountStatus,
  setFilterAccountIds,
  setFilterCategoryIds,
  setFilterPayeeIds,
  setFilterStartDate,
  setFilterEndDate,
  setFilterSearch,
  setFilterTimePeriod,
  filtersExpanded,
  setFiltersExpanded,
  activeFilterCount,
  filteredAccounts,
  selectedAccounts,
  selectedCategories,
  selectedPayees,
  accountFilterOptions,
  categoryFilterOptions,
  payeeFilterOptions,
  formatDate,
  onClearFilters,
  bulkSelectMode,
  onToggleBulkSelectMode,
}: TransactionFilterPanelProps) {
  return (
    <>
      {/* Quick Account Select - Favourites */}
      {filteredAccounts.filter(a => a.isFavourite).length > 0 && (
        <div className="flex items-center gap-2 mb-4 overflow-x-auto pb-1">
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap flex-shrink-0">
            Favourites:
          </span>
          {filteredAccounts
            .filter(a => a.isFavourite)
            .sort((a, b) => a.name.localeCompare(b.name))
            .map(account => {
              const isSelected = filterAccountIds.includes(account.id);
              return (
                <button
                  key={account.id}
                  onClick={() => {
                    if (isSelected && filterAccountIds.length === 1) {
                      handleArrayFilterChange(setFilterAccountIds, []);
                    } else {
                      handleArrayFilterChange(setFilterAccountIds, [account.id]);
                    }
                  }}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium whitespace-nowrap transition-colors ${
                    isSelected
                      ? 'bg-emerald-700 text-white dark:bg-emerald-600'
                      : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
                  }`}
                >
                  <svg className="w-3.5 h-3.5 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
                    <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z" />
                  </svg>
                  {account.name}
                </button>
              );
            })}
        </div>
      )}

      {/* Filters - Collapsible Panel */}
      <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg mb-6">
        {/* Filter Header - Always Visible, Clickable to toggle */}
        <div
          className="px-4 py-3 sm:px-6 cursor-pointer select-none"
          onClick={() => setFiltersExpanded(!filtersExpanded)}
        >
          <div className="flex items-center justify-between gap-4">
            {/* Left side: Filter icon, title, and count */}
            <div className="flex items-center gap-2 min-w-0">
              <svg className="w-5 h-5 text-gray-500 dark:text-gray-400 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
              </svg>
              <span className="text-sm font-medium text-gray-900 dark:text-gray-100">Filters</span>
              {activeFilterCount > 0 && (
                <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 text-xs font-medium rounded-full bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200">
                  {activeFilterCount}
                </span>
              )}
            </div>

            {/* Right side: Clear and Toggle buttons */}
            <div className="flex items-center gap-2 flex-shrink-0">
              {activeFilterCount > 0 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onClearFilters();
                  }}
                  className="text-xs font-medium text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
                >
                  Clear
                </button>
              )}
              <span className="inline-flex items-center gap-1 text-sm font-medium text-blue-600 dark:text-blue-400">
                {filtersExpanded ? 'Hide' : 'Show'}
                <svg
                  className={`w-4 h-4 transition-transform duration-200 ${filtersExpanded ? 'rotate-180' : ''}`}
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                >
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                </svg>
              </span>
            </div>
          </div>

          {/* Active Filter Chips - Show when collapsed and filters are active */}
          {!filtersExpanded && activeFilterCount > 0 && (
            <div role="presentation" className="flex gap-2 mt-3 overflow-x-auto pb-1 -mx-4 px-4 sm:mx-0 sm:px-0 sm:flex-wrap sm:overflow-visible" onClick={(e) => e.stopPropagation()}>
              {/* Account chips - Emerald */}
              {selectedAccounts.map(account => (
                <span
                  key={`account-${account.id}`}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-emerald-100 dark:bg-emerald-900 text-emerald-800 dark:text-emerald-200 whitespace-nowrap"
                >
                  {account.name}
                  <button
                    onClick={() => handleArrayFilterChange(setFilterAccountIds, filterAccountIds.filter(id => id !== account.id))}
                    className="ml-0.5 -mr-1 p-0.5 rounded-full inline-flex items-center justify-center hover:bg-emerald-200 dark:hover:bg-emerald-800"
                    aria-label={`Remove ${account.name} filter`}
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              ))}
              {/* Category chips - Blue with color dot */}
              {selectedCategories.map(cat => (
                <span
                  key={`category-${cat.id}`}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-100 dark:bg-blue-900 text-blue-800 dark:text-blue-200 whitespace-nowrap"
                >
                  {(cat.effectiveColor ?? cat.color) && (
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: (cat.effectiveColor ?? cat.color)! }}
                    />
                  )}
                  {cat.name}
                  <button
                    onClick={() => handleArrayFilterChange(setFilterCategoryIds, filterCategoryIds.filter(id => id !== cat.id))}
                    className="ml-0.5 -mr-1 p-0.5 rounded-full inline-flex items-center justify-center hover:bg-blue-200 dark:hover:bg-blue-800"
                    aria-label={`Remove ${cat.name} filter`}
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              ))}
              {/* Payee chips - Purple */}
              {selectedPayees.map(payee => (
                <span
                  key={`payee-${payee.id}`}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-purple-100 dark:bg-purple-900 text-purple-800 dark:text-purple-200 whitespace-nowrap"
                >
                  {payee.name}
                  <button
                    onClick={() => handleArrayFilterChange(setFilterPayeeIds, filterPayeeIds.filter(id => id !== payee.id))}
                    className="ml-0.5 -mr-1 p-0.5 rounded-full inline-flex items-center justify-center hover:bg-purple-200 dark:hover:bg-purple-800"
                    aria-label={`Remove ${payee.name} filter`}
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              ))}
              {/* Date range chip - Amber */}
              {(filterStartDate || filterEndDate) && (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-200 whitespace-nowrap">
                  {filterStartDate && filterEndDate
                    ? `${formatDate(filterStartDate)} - ${formatDate(filterEndDate)}`
                    : filterStartDate
                      ? `From ${formatDate(filterStartDate)}`
                      : `Until ${formatDate(filterEndDate)}`}
                  <button
                    onClick={() => {
                      handleFilterChange(setFilterStartDate, '');
                      handleFilterChange(setFilterEndDate, '');
                    }}
                    className="ml-0.5 -mr-1 p-0.5 rounded-full inline-flex items-center justify-center hover:bg-amber-200 dark:hover:bg-amber-800"
                    aria-label="Remove date filter"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              )}
              {/* Search chip - Gray */}
              {filterSearch && (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-gray-100 dark:bg-gray-700 text-gray-800 dark:text-gray-200 whitespace-nowrap">
                  &quot;{filterSearch}&quot;
                  <button
                    onClick={() => handleFilterChange(setFilterSearch, '')}
                    className="ml-0.5 -mr-1 p-0.5 rounded-full inline-flex items-center justify-center hover:bg-gray-200 dark:hover:bg-gray-600"
                    aria-label="Remove search filter"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                </span>
              )}
            </div>
          )}
        </div>

        {/* Collapsible Filter Body */}
        <div
          className="grid transition-[grid-template-rows] duration-200 ease-in-out"
          style={{ gridTemplateRows: filtersExpanded ? '1fr' : '0fr' }}
        >
          <div className={filtersExpanded ? '' : 'overflow-hidden'}>
            <div className="px-4 pb-4 sm:px-6 border-t border-gray-200 dark:border-gray-700">
              {/* Account status segmented control + Bulk Update button */}
              <div className="flex flex-wrap items-center gap-3 pt-4 pb-2">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">Show accounts:</span>
                <div className="inline-flex rounded-md shadow-sm">
                  <button
                    onClick={() => setFilterAccountStatus('')}
                    className={`px-3 py-1.5 text-sm font-medium rounded-l-md border ${
                      filterAccountStatus === ''
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
                    }`}
                  >
                    All
                  </button>
                  <button
                    onClick={() => setFilterAccountStatus('active')}
                    className={`px-3 py-1.5 text-sm font-medium border-t border-b ${
                      filterAccountStatus === 'active'
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
                    }`}
                  >
                    Active
                  </button>
                  <button
                    onClick={() => setFilterAccountStatus('closed')}
                    className={`px-3 py-1.5 text-sm font-medium rounded-r-md border ${
                      filterAccountStatus === 'closed'
                        ? 'bg-blue-600 text-white border-blue-600'
                        : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
                    }`}
                  >
                    Closed
                  </button>
                </div>
                {onToggleBulkSelectMode && (
                  <Button
                    variant={bulkSelectMode ? 'secondary' : 'outline'}
                    size="sm"
                    onClick={onToggleBulkSelectMode}
                    className="hidden sm:inline-flex ml-auto"
                  >
                    {bulkSelectMode ? 'Cancel Bulk' : 'Bulk Update'}
                  </Button>
                )}
              </div>

              {/* First row: Main filters */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 pt-2">
                <MultiSelect
                  label="Accounts"
                  options={accountFilterOptions}
                  value={filterAccountIds}
                  onChange={(values) => handleArrayFilterChange(setFilterAccountIds, values)}
                  placeholder="All accounts"
                />

                <MultiSelect
                  label="Categories"
                  options={categoryFilterOptions}
                  value={filterCategoryIds}
                  onChange={(values) => handleArrayFilterChange(setFilterCategoryIds, values)}
                  placeholder="All categories"
                />

                <MultiSelect
                  label="Payees"
                  options={payeeFilterOptions}
                  value={filterPayeeIds}
                  onChange={(values) => handleArrayFilterChange(setFilterPayeeIds, values)}
                  placeholder="All payees"
                />
              </div>

              {/* Second row: Time period, dates, and search */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mt-4">
                <Select
                  label="Time Period"
                  options={TIME_PERIOD_OPTIONS}
                  value={filterTimePeriod}
                  onChange={(e) => {
                    const period = e.target.value;
                    setFilterTimePeriod(period);
                    if (period && period !== 'custom') {
                      const { startDate, endDate } = resolveTimePeriod(period as TimePeriod, weekStartsOn);
                      handleFilterChange(setFilterStartDate, startDate);
                      handleFilterChange(setFilterEndDate, endDate);
                    }
                  }}
                />

                <Input
                  label="Start Date"
                  type="date"
                  value={filterStartDate}
                  onChange={(e) => {
                    handleFilterChange(setFilterStartDate, e.target.value);
                    if (filterTimePeriod && filterTimePeriod !== 'custom') {
                      setFilterTimePeriod('custom');
                    }
                  }}
                />

                <Input
                  label="End Date"
                  type="date"
                  value={filterEndDate}
                  onChange={(e) => {
                    handleFilterChange(setFilterEndDate, e.target.value);
                    if (filterTimePeriod && filterTimePeriod !== 'custom') {
                      setFilterTimePeriod('custom');
                    }
                  }}
                />

                <Input
                  label="Search"
                  type="text"
                  value={searchInput}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  placeholder="Search descriptions..."
                />
              </div>

              {/* Bulk Update button - mobile only (full width at bottom) */}
              {onToggleBulkSelectMode && (
                <Button
                  variant={bulkSelectMode ? 'secondary' : 'outline'}
                  size="sm"
                  onClick={onToggleBulkSelectMode}
                  className="w-full mt-4 sm:hidden"
                >
                  {bulkSelectMode ? 'Cancel Bulk' : 'Bulk Update'}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
