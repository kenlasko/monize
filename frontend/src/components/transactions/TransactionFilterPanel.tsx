'use client';

import { FilterPanelHeader } from '@/components/ui/FilterPanelHeader';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { MultiSelect, MultiSelectOption } from '@/components/ui/MultiSelect';
import { exchangeRatesApi } from '@/lib/exchange-rates';
import { Input } from '@/components/ui/Input';
import { CurrencyInput } from '@/components/ui/CurrencyInput';
import { DateInput } from '@/components/ui/DateInput';
import { Select } from '@/components/ui/Select';
import { Button } from '@/components/ui/Button';
import { Account } from '@/types/account';
import { Category } from '@/types/category';
import { Payee } from '@/types/payee';
import { Tag } from '@/types/tag';
import { SearchInterpretation, TransactionStatus } from '@/types/transaction';
import { TimePeriod, TIME_PERIOD_OPTIONS, resolveTimePeriod } from '@/lib/time-periods';
import { collectTagKeys } from '@/lib/tag-key-value';
import { orderAccountsForPicker } from '@/lib/account-utils';
import { TagKeyOp } from '@/hooks/useTransactionFilters';
import { SearchSyntaxHelp } from './SearchSyntaxHelp';
import { SearchInterpretationLine } from './SearchInterpretationLine';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';
import { XMarkIcon } from '@heroicons/react/24/outline';


interface TransactionFilterPanelProps {
  filterAccountIds: string[];
  filterCategoryIds: string[];
  filterPayeeIds: string[];
  filterStartDate: string;
  filterEndDate: string;
  filterSearch: string;
  searchInput: string;
  /** How the server read the applied search, from the last register response. */
  searchInterpretation?: SearchInterpretation;
  filterAccountStatus: 'active' | 'closed' | '';
  filterTimePeriod: string;
  filterAmountFrom: string;
  filterAmountTo: string;
  filterTagIds: string[];
  filterStatuses: TransactionStatus[];
  filterOriginalCurrencyCodes: string[];
  filterTagKey: string;
  filterTagKeyOp: TagKeyOp;
  filterTagKeyValue: string;
  filterHasAttachments: '' | 'yes' | 'no';
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
  setFilterAmountFrom: (value: string) => void;
  setFilterAmountTo: (value: string) => void;
  setFilterTagIds: (value: string[]) => void;
  setFilterStatuses: (value: TransactionStatus[]) => void;
  setFilterOriginalCurrencyCodes: (value: string[]) => void;
  setFilterTagKey: (value: string) => void;
  setFilterTagKeyOp: (value: TagKeyOp) => void;
  setFilterTagKeyValue: (value: string) => void;
  setFilterHasAttachments: (value: '' | 'yes' | 'no') => void;
  filtersExpanded: boolean;
  setFiltersExpanded: (value: boolean) => void;
  activeFilterCount: number;
  filteredAccounts: Account[];
  /** How many accounts each status segment holds. */
  accountStatusCounts: { all: number; active: number; closed: number };
  selectedAccounts: Account[];
  selectedCategories: Category[];
  selectedPayees: Payee[];
  selectedTags: Tag[];
  accountFilterOptions: MultiSelectOption[];
  categoryFilterOptions: MultiSelectOption[];
  payeeFilterOptions: MultiSelectOption[];
  tagFilterOptions: MultiSelectOption[];
  formatDate: (date: string) => string;
  onClearFilters: () => void;
  bulkSelectMode?: boolean;
  onToggleBulkSelectMode?: () => void;
  /**
   * Withhold the time-period and date fields, and the chip that summarises
   * them.
   *
   * Calendar mode's date filter is the month on screen (design decision 2), so
   * offering a second one would let the two disagree with no way to tell which
   * the rows answered. Every other filter still reaches the request.
   */
  hideDateRange?: boolean;
}

export function TransactionFilterPanel({
  filterAccountIds,
  filterCategoryIds,
  filterPayeeIds,
  filterStartDate,
  filterEndDate,
  filterSearch,
  searchInput,
  searchInterpretation,
  filterAccountStatus,
  filterTimePeriod,
  filterAmountFrom,
  filterAmountTo,
  filterTagIds,
  filterStatuses,
  filterOriginalCurrencyCodes,
  filterTagKey,
  filterTagKeyOp,
  filterTagKeyValue,
  filterHasAttachments,
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
  setFilterAmountFrom,
  setFilterAmountTo,
  setFilterTagIds,
  setFilterStatuses,
  setFilterOriginalCurrencyCodes,
  setFilterTagKey,
  setFilterTagKeyOp,
  setFilterTagKeyValue,
  setFilterHasAttachments,
  filtersExpanded,
  setFiltersExpanded,
  activeFilterCount,
  filteredAccounts,
  accountStatusCounts,
  selectedAccounts,
  selectedCategories,
  selectedPayees,
  selectedTags,
  accountFilterOptions,
  categoryFilterOptions,
  payeeFilterOptions,
  tagFilterOptions,
  formatDate,
  onClearFilters,
  bulkSelectMode,
  onToggleBulkSelectMode,
  hideDateRange = false,
}: TransactionFilterPanelProps) {
  const t = useTranslations('transactions');

  const STATUS_LABELS: Record<TransactionStatus, string> = {
    [TransactionStatus.UNRECONCILED]: t('filter.statusLabels.unreconciled'),
    [TransactionStatus.CLEARED]: t('filter.statusLabels.cleared'),
    [TransactionStatus.RECONCILED]: t('filter.statusLabels.reconciled'),
    [TransactionStatus.VOID]: t('filter.statusLabels.void'),
  };

  // KEY:VALUE tag keys the user actually has (e.g. "country", "sector"). The
  // whole key filter is only offered when at least one key:value tag exists.
  const availableTagKeys = collectTagKeys(tagFilterOptions.map((o) => o.label));
  const tagKeyOpOptions: { value: TagKeyOp; label: string }[] = [
    { value: 'hasValue', label: t('filter.tagKeyOps.hasValue') },
    { value: 'noValue', label: t('filter.tagKeyOps.noValue') },
    { value: 'contains', label: t('filter.tagKeyOps.contains') },
    { value: 'notContains', label: t('filter.tagKeyOps.notContains') },
  ];
  const tagKeyNeedsValue =
    filterTagKeyOp === 'contains' || filterTagKeyOp === 'notContains';

  const STATUS_FILTER_OPTIONS: MultiSelectOption[] = [
    { value: TransactionStatus.UNRECONCILED, label: STATUS_LABELS[TransactionStatus.UNRECONCILED] },
    { value: TransactionStatus.CLEARED, label: STATUS_LABELS[TransactionStatus.CLEARED] },
    { value: TransactionStatus.RECONCILED, label: STATUS_LABELS[TransactionStatus.RECONCILED] },
    { value: TransactionStatus.VOID, label: STATUS_LABELS[TransactionStatus.VOID] },
  ];

  // Currency filter options: the user's active currencies, merged with any codes
  // already selected (so a filter restored from the URL still shows its chips).
  const [activeCurrencyCodes, setActiveCurrencyCodes] = useState<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    exchangeRatesApi
      .getCurrencies()
      .then((rows) => {
        if (!cancelled) {
          setActiveCurrencyCodes(rows.filter((c) => c.isActive).map((c) => c.code));
        }
      })
      .catch(() => {
        /* leave options to the selected codes only */
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const CURRENCY_FILTER_OPTIONS: MultiSelectOption[] = Array.from(
    new Set([...activeCurrencyCodes, ...filterOriginalCurrencyCodes]),
  )
    .sort()
    .map((code) => ({ value: code, label: code }));
  const hasCurrencyFilter = CURRENCY_FILTER_OPTIONS.length > 0;

  // Same order the account switcher beside this filter uses -- these two
  // controls sit on one page over one set of accounts, so the chips and the
  // caret's Favourites section cannot be arranged differently. `.sort()` also
  // reorders in place, and `filteredAccounts` is a memo other consumers read.
  const { favourites: favouriteAccounts } = orderAccountsForPicker(filteredAccounts);

  return (
    <>
      {/* Quick Account Select - Favourites */}
      {favouriteAccounts.length > 0 && (
        <div className="flex items-center gap-2 mb-4 overflow-x-auto scrollbar-hide">
          <span className="text-xs font-medium text-gray-500 dark:text-gray-400 whitespace-nowrap flex-shrink-0">
            {t('filter.favourites')}
          </span>
          {favouriteAccounts
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
        <div className="px-4 py-3 sm:px-6">
          <FilterPanelHeader
            expanded={filtersExpanded}
            count={activeFilterCount}
            onToggle={() => setFiltersExpanded(!filtersExpanded)}
            onClear={onClearFilters}
          />

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
                    aria-label={t('filter.chips.removeAccount', { name: account.name })}
                  >
                    <XMarkIcon className="w-3 h-3" aria-hidden="true" />
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
                    aria-label={t('filter.chips.removePayee', { name: payee.name })}
                  >
                    <XMarkIcon className="w-3 h-3" aria-hidden="true" />
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
                    aria-label={t('filter.chips.removeCategory', { name: cat.name })}
                  >
                    <XMarkIcon className="w-3 h-3" aria-hidden="true" />
                  </button>
                </span>
              ))}
              {/* Tag chips - Rose */}
              {selectedTags.map(tag => (
                <span
                  key={`tag-${tag.id}`}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-rose-100 dark:bg-rose-900 text-rose-800 dark:text-rose-200 whitespace-nowrap"
                >
                  {tag.color && (
                    <span
                      className="w-2 h-2 rounded-full flex-shrink-0"
                      style={{ backgroundColor: tag.color }}
                    />
                  )}
                  {tag.name}
                  <button
                    onClick={() => handleArrayFilterChange(setFilterTagIds, filterTagIds.filter(id => id !== tag.id))}
                    className="ml-0.5 -mr-1 p-0.5 rounded-full inline-flex items-center justify-center hover:bg-rose-200 dark:hover:bg-rose-800"
                    aria-label={t('filter.chips.removeTag', { name: tag.name })}
                  >
                    <XMarkIcon className="w-3 h-3" aria-hidden="true" />
                  </button>
                </span>
              ))}
              {/* Date range chip - Amber */}
              {!hideDateRange && (filterStartDate || filterEndDate) && (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-amber-100 dark:bg-amber-900 text-amber-800 dark:text-amber-200 whitespace-nowrap">
                  {filterStartDate && filterEndDate
                    ? `${formatDate(filterStartDate)} - ${formatDate(filterEndDate)}`
                    : filterStartDate
                      ? t('filter.chips.dateFrom', { date: formatDate(filterStartDate) })
                      : t('filter.chips.dateUntil', { date: formatDate(filterEndDate) })}
                  <button
                    onClick={() => {
                      handleFilterChange(setFilterStartDate, '');
                      handleFilterChange(setFilterEndDate, '');
                    }}
                    className="ml-0.5 -mr-1 p-0.5 rounded-full inline-flex items-center justify-center hover:bg-amber-200 dark:hover:bg-amber-800"
                    aria-label={t('filter.chips.removeDate')}
                  >
                    <XMarkIcon className="w-3 h-3" aria-hidden="true" />
                  </button>
                </span>
              )}
              {/* Amount range chip - Teal */}
              {(filterAmountFrom || filterAmountTo) && (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-teal-100 dark:bg-teal-900 text-teal-800 dark:text-teal-200 whitespace-nowrap">
                  {filterAmountFrom && filterAmountTo
                    ? `${filterAmountFrom} - ${filterAmountTo}`
                    : filterAmountFrom
                      ? t('filter.chips.amountFrom', { amount: filterAmountFrom })
                      : t('filter.chips.amountUpTo', { amount: filterAmountTo })}
                  <button
                    onClick={() => {
                      handleFilterChange(setFilterAmountFrom, '');
                      handleFilterChange(setFilterAmountTo, '');
                    }}
                    className="ml-0.5 -mr-1 p-0.5 rounded-full inline-flex items-center justify-center hover:bg-teal-200 dark:hover:bg-teal-800"
                    aria-label={t('filter.chips.removeAmount')}
                  >
                    <XMarkIcon className="w-3 h-3" aria-hidden="true" />
                  </button>
                </span>
              )}
              {/* Reconciliation status chips - Indigo */}
              {filterStatuses.map(status => (
                <span
                  key={`status-${status}`}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-indigo-100 dark:bg-indigo-900 text-indigo-800 dark:text-indigo-200 whitespace-nowrap"
                >
                  {STATUS_LABELS[status]}
                  <button
                    onClick={() => handleArrayFilterChange(setFilterStatuses, filterStatuses.filter(s => s !== status))}
                    className="ml-0.5 -mr-1 p-0.5 rounded-full inline-flex items-center justify-center hover:bg-indigo-200 dark:hover:bg-indigo-800"
                    aria-label={t('filter.chips.removeAccount', { name: STATUS_LABELS[status] })}
                  >
                    <XMarkIcon className="w-3 h-3" aria-hidden="true" />
                  </button>
                </span>
              ))}
              {/* Currency chips - Cyan */}
              {filterOriginalCurrencyCodes.map(code => (
                <span
                  key={`currency-${code}`}
                  className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-cyan-100 dark:bg-cyan-900 text-cyan-800 dark:text-cyan-200 whitespace-nowrap"
                >
                  {code}
                  <button
                    onClick={() => handleArrayFilterChange(setFilterOriginalCurrencyCodes, filterOriginalCurrencyCodes.filter(c => c !== code))}
                    className="ml-0.5 -mr-1 p-0.5 rounded-full inline-flex items-center justify-center hover:bg-cyan-200 dark:hover:bg-cyan-800"
                    aria-label={t('filter.chips.removeCurrency', { name: code })}
                  >
                    <XMarkIcon className="w-3 h-3" aria-hidden="true" />
                  </button>
                </span>
              ))}
              {/* Attachments chip - Lime */}
              {filterHasAttachments && (
                <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-lime-100 dark:bg-lime-900 text-lime-800 dark:text-lime-200 whitespace-nowrap">
                  {filterHasAttachments === 'yes'
                    ? t('filter.chips.hasAttachments')
                    : t('filter.chips.noAttachments')}
                  <button
                    onClick={() => handleFilterChange(setFilterHasAttachments as (value: string) => void, '')}
                    className="ml-0.5 -mr-1 p-0.5 rounded-full inline-flex items-center justify-center hover:bg-lime-200 dark:hover:bg-lime-800"
                    aria-label={t('filter.chips.removeAttachments')}
                  >
                    <XMarkIcon className="w-3 h-3" aria-hidden="true" />
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
                    aria-label={t('filter.chips.removeSearch')}
                  >
                    <XMarkIcon className="w-3 h-3" aria-hidden="true" />
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
                {/* Search first, with no label above it: the placeholder says
                    what is searched. */}
                <div className="w-full sm:w-auto sm:min-w-[16rem] sm:flex-1 sm:max-w-md">
                  <div className="flex items-center gap-1">
                    <div className="min-w-0 flex-1">
                      <Input
                        aria-label={t('filter.fields.search')}
                        type="text"
                        value={searchInput}
                        onChange={(e) => handleSearchChange(e.target.value)}
                        placeholder={t('filter.placeholders.search')}
                      />
                    </div>
                    <SearchSyntaxHelp onExample={handleSearchChange} />
                  </div>
                  {filterSearch && (
                    <SearchInterpretationLine interpretation={searchInterpretation} />
                  )}
                </div>
                <span id="filter-account-status-label" className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('filter.accounts.label')}
                </span>
                <div role="group" aria-labelledby="filter-account-status-label" className={SEGMENTED_GROUP_CLASS}>
                  {(
                    [
                      ['', t('filter.accounts.allCount', { count: accountStatusCounts.all })],
                      ['active', t('filter.accounts.activeCount', { count: accountStatusCounts.active })],
                      ['closed', t('filter.accounts.closedCount', { count: accountStatusCounts.closed })],
                    ] as const
                  ).map(([status, label]) => (
                    <button
                      key={status || 'all'}
                      type="button"
                      onClick={() => setFilterAccountStatus(status)}
                      aria-pressed={filterAccountStatus === status}
                      className={segmentClass(filterAccountStatus === status)}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {onToggleBulkSelectMode && (
                  <Button
                    variant={bulkSelectMode ? 'secondary' : 'outline'}
                    size="sm"
                    onClick={onToggleBulkSelectMode}
                    className="hidden sm:inline-flex ml-auto"
                  >
                    {bulkSelectMode ? t('filter.cancelBulk') : t('filter.bulkUpdate')}
                  </Button>
                )}
              </div>

              {/* First row: Main filters */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 pt-2">
                <MultiSelect
                  label={t('filter.fields.accounts')}
                  options={accountFilterOptions}
                  value={filterAccountIds}
                  onChange={(values) => handleArrayFilterChange(setFilterAccountIds, values)}
                  placeholder={t('filter.placeholders.accounts')}
                />

                <MultiSelect
                  label={t('filter.fields.payees')}
                  options={payeeFilterOptions}
                  value={filterPayeeIds}
                  onChange={(values) => handleArrayFilterChange(setFilterPayeeIds, values)}
                  placeholder={t('filter.placeholders.payees')}
                />

                <MultiSelect
                  label={t('filter.fields.categories')}
                  options={categoryFilterOptions}
                  value={filterCategoryIds}
                  onChange={(values) => handleArrayFilterChange(setFilterCategoryIds, values)}
                  placeholder={t('filter.placeholders.categories')}
                />

                <MultiSelect
                  label={t('filter.fields.tags')}
                  options={tagFilterOptions}
                  value={filterTagIds}
                  onChange={(values) => handleArrayFilterChange(setFilterTagIds, values)}
                  placeholder={t('filter.placeholders.tags')}
                />

                <MultiSelect
                  label={t('filter.fields.status')}
                  options={STATUS_FILTER_OPTIONS}
                  value={filterStatuses}
                  onChange={(values) => handleArrayFilterChange(setFilterStatuses, values as TransactionStatus[])}
                  placeholder={t('filter.placeholders.statuses')}
                  showSearch={false}
                />
              </div>

              {/* KEY:VALUE tag key filter. Only shown when the user has at least
                  one key:value tag (e.g. country:usa). Choose a key, an operator,
                  and (for contains/notContains) a term. */}
              {availableTagKeys.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[2fr_2fr_3fr] gap-4 mt-4">
                  <Select
                    label={t('filter.fields.tagKey')}
                    options={[
                      { value: '', label: t('filter.tagKeyNone') },
                      ...availableTagKeys.map((k) => ({ value: k, label: k })),
                    ]}
                    value={filterTagKey}
                    onChange={(e) =>
                      handleFilterChange(setFilterTagKey, e.target.value)
                    }
                  />
                  <Select
                    label={t('filter.fields.tagKeyOp')}
                    options={tagKeyOpOptions}
                    value={filterTagKeyOp}
                    disabled={!filterTagKey}
                    onChange={(e) =>
                      handleFilterChange(
                        setFilterTagKeyOp as (value: string) => void,
                        e.target.value,
                      )
                    }
                  />
                  {tagKeyNeedsValue && (
                    <Input
                      label={t('filter.fields.tagKeyValue')}
                      value={filterTagKeyValue}
                      disabled={!filterTagKey}
                      placeholder={t('filter.placeholders.tagKeyValue')}
                      onChange={(e) =>
                        handleFilterChange(setFilterTagKeyValue, e.target.value)
                      }
                    />
                  )}
                </div>
              )}

              {/* Second row: Time period, dates, amount range, currency,
                  attachments, and search on one lg row. The fr weights are
                  integers (so Tailwind reliably emits the arbitrary class):
                  Time Period 34, each date 27 (another ~10% shaved off and
                  given to Time Period), the narrow controls 20 (1fr), and
                  Search 60 (3fr). The Currency column is dropped when it isn't
                  shown. */}
              {/* Written out rather than composed: Tailwind emits a utility
                  only for a class it can find as a literal in the source. */}
              <div
                className={`grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4 ${
                  hideDateRange
                    ? hasCurrencyFilter
                      ? 'lg:grid-cols-[20fr_20fr_20fr_20fr_60fr]'
                      : 'lg:grid-cols-[20fr_20fr_20fr_60fr]'
                    : hasCurrencyFilter
                      ? 'lg:grid-cols-[34fr_27fr_27fr_20fr_20fr_20fr_20fr_60fr]'
                      : 'lg:grid-cols-[34fr_27fr_27fr_20fr_20fr_20fr_60fr]'
                }`}
              >
                {!hideDateRange && (
                  <>
                <Select
                  label={t('filter.fields.timePeriod')}
                  options={TIME_PERIOD_OPTIONS.map((o) => ({ value: o.value, label: t(o.labelKey) }))}
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

                <DateInput
                  label={t('filter.fields.startDate')}
                  value={filterStartDate}
                  onDateChange={(date) => {
                    handleFilterChange(setFilterStartDate, date);
                    if (filterTimePeriod && filterTimePeriod !== 'custom') {
                      setFilterTimePeriod('custom');
                    }
                  }}
                  onChange={(e) => {
                    handleFilterChange(setFilterStartDate, e.target.value);
                    if (filterTimePeriod && filterTimePeriod !== 'custom') {
                      setFilterTimePeriod('custom');
                    }
                  }}
                />

                <DateInput
                  label={t('filter.fields.endDate')}
                  value={filterEndDate}
                  onDateChange={(date) => {
                    handleFilterChange(setFilterEndDate, date);
                    if (filterTimePeriod && filterTimePeriod !== 'custom') {
                      setFilterTimePeriod('custom');
                    }
                  }}
                  onChange={(e) => {
                    handleFilterChange(setFilterEndDate, e.target.value);
                    if (filterTimePeriod && filterTimePeriod !== 'custom') {
                      setFilterTimePeriod('custom');
                    }
                  }}
                />
                  </>
                )}

                <CurrencyInput
                  label={t('filter.fields.amountFrom')}
                  allowCalculator={false}
                  value={filterAmountFrom === '' ? undefined : Number(filterAmountFrom)}
                  onChange={(value) =>
                    handleFilterChange(setFilterAmountFrom, value === undefined ? '' : String(value))
                  }
                  placeholder={t('filter.placeholders.amountMin')}
                />

                <CurrencyInput
                  label={t('filter.fields.amountTo')}
                  allowCalculator={false}
                  value={filterAmountTo === '' ? undefined : Number(filterAmountTo)}
                  onChange={(value) =>
                    handleFilterChange(setFilterAmountTo, value === undefined ? '' : String(value))
                  }
                  placeholder={t('filter.placeholders.amountMax')}
                />

                {hasCurrencyFilter && (
                  <MultiSelect
                    label={t('filter.fields.currency')}
                    options={CURRENCY_FILTER_OPTIONS}
                    value={filterOriginalCurrencyCodes}
                    onChange={(values) => handleArrayFilterChange(setFilterOriginalCurrencyCodes, values as string[])}
                    placeholder={t('filter.fields.currency')}
                  />
                )}

                <Select
                  label={t('filter.fields.hasAttachments')}
                  options={[
                    { value: '', label: t('filter.hasAttachmentsOptions.any') },
                    { value: 'yes', label: t('filter.hasAttachmentsOptions.yes') },
                    { value: 'no', label: t('filter.hasAttachmentsOptions.no') },
                  ]}
                  value={filterHasAttachments}
                  onChange={(e) =>
                    handleFilterChange(
                      setFilterHasAttachments as (value: string) => void,
                      e.target.value,
                    )
                  }
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
                  {bulkSelectMode ? t('filter.cancelBulk') : t('filter.bulkUpdate')}
                </Button>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
