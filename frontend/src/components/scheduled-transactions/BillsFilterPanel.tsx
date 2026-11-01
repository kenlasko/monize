'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { FilterPanelHeader } from '@/components/ui/FilterPanelHeader';
import { MultiSelect, MultiSelectOption } from '@/components/ui/MultiSelect';
import {
  SEGMENTED_TOOLBAR_GROUP_CLASS,
  toolbarSegmentClass,
} from '@/components/ui/segmented-control';
import { Account } from '@/types/account';
import { Category } from '@/types/category';
import { BillsPayeeOption, BillsTypeFilter } from '@/lib/bills-filters';
import { buildCategoryFilterOptions, resolveSelectedCategories } from '@/lib/categoryUtils';
import { useCategoryFilterLabels } from '@/hooks/useCategoryFilterLabels';

const TYPE_FILTERS: readonly BillsTypeFilter[] = ['all', 'bills', 'deposits'];

interface BillsFilterPanelProps {
  filterType: BillsTypeFilter;
  setFilterType: (type: BillsTypeFilter) => void;
  /** How many schedules each type segment would show. */
  typeCounts: Record<BillsTypeFilter, number>;
  filtersExpanded: boolean;
  setFiltersExpanded: (expanded: boolean) => void;
  nameSearch: string;
  setNameSearch: (term: string) => void;
  selectedPayeeIds: string[];
  setSelectedPayeeIds: (ids: string[]) => void;
  selectedAccountIds: string[];
  setSelectedAccountIds: (ids: string[]) => void;
  selectedCategoryIds: string[];
  setSelectedCategoryIds: (ids: string[]) => void;
  accounts: Account[];
  categories: Category[];
  payees: BillsPayeeOption[];
  activeFilterCount: number;
  onClearFilters: () => void;
}

export function BillsFilterPanel(props: BillsFilterPanelProps) {
  const t = useTranslations('scheduledTransactions');
  const tBills = useTranslations('bills');
  const {
    filterType,
    setFilterType,
    typeCounts,
    filtersExpanded,
    setFiltersExpanded,
    nameSearch,
    setNameSearch,
    selectedPayeeIds,
    setSelectedPayeeIds,
    selectedAccountIds,
    setSelectedAccountIds,
    selectedCategoryIds,
    setSelectedCategoryIds,
    accounts,
    categories,
    payees,
    activeFilterCount,
    onClearFilters,
  } = props;

  const accountOptions: MultiSelectOption[] = useMemo(
    () => accounts.map((a) => ({ value: a.id, label: a.name })),
    [accounts],
  );

  const payeeOptions: MultiSelectOption[] = useMemo(
    () => payees.map((p) => ({ value: p.id, label: p.name })),
    [payees],
  );

  const categoryFilterLabels = useCategoryFilterLabels();
  const categoryOptions: MultiSelectOption[] = useMemo(
    () => buildCategoryFilterOptions(categories, categoryFilterLabels),
    [categories, categoryFilterLabels],
  );

  const selectedCategories = useMemo(
    () => resolveSelectedCategories(selectedCategoryIds, categories, categoryFilterLabels),
    [selectedCategoryIds, categories, categoryFilterLabels],
  );

  return (
    <div className="bg-white dark:bg-gray-800 shadow dark:shadow-gray-700/50 rounded-lg">
      {/* Filter header: the same fold toggle ("Show filters" / "Hide" with
          its chevron), count badge and Clear as the Transactions register's
          panel. The panel may fold only because the folded header still says
          how many filters apply, offers Clear, and lists each active filter
          as a removable chip below. */}
      <div className="px-4 py-3 sm:px-6">
        <FilterPanelHeader
          expanded={filtersExpanded}
          count={activeFilterCount}
          onToggle={() => setFiltersExpanded(!filtersExpanded)}
          onClear={onClearFilters}
        />
      </div>

      {/* Active filter chips (collapsed view) */}
      {!filtersExpanded && activeFilterCount > 0 && (
        <div className="px-4 pb-4 sm:px-6 flex flex-wrap gap-2">
          {filterType !== 'all' && (
            <span className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 text-xs rounded-full">
              {filterType === 'bills' ? tBills('viewTabs.chipBills') : tBills('viewTabs.chipDeposits')}
              <button
                type="button"
                onClick={() => setFilterType('all')}
                aria-label={tBills('viewTabs.clearType')}
                className="hover:text-gray-900 dark:hover:text-gray-100"
              >
                <XMarkIcon className="w-3 h-3" aria-hidden="true" />
              </button>
            </span>
          )}
          {nameSearch.trim() && (
            <span className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 text-xs rounded-full">
              &quot;{nameSearch}&quot;
              <button onClick={() => setNameSearch('')} className="hover:text-gray-900 dark:hover:text-gray-100">
                <XMarkIcon className="w-3 h-3" aria-hidden="true" />
              </button>
            </span>
          )}
          {/* Always render a chip for every selected id so a selection that has
              dropped out of the derived list (e.g. its only schedule was
              deleted) stays removable rather than leaving an active filter the
              user cannot clear. */}
          {selectedPayeeIds.map((id) => {
            const payee = payees.find((p) => p.id === id);
            return (
              <span key={id} className="inline-flex items-center gap-1 px-2 py-1 bg-purple-100 dark:bg-purple-900/40 text-purple-700 dark:text-purple-300 text-xs rounded-full">
                {payee?.name ?? 'Unknown payee'}
                <button onClick={() => setSelectedPayeeIds(selectedPayeeIds.filter((p) => p !== id))} className="hover:text-purple-900 dark:hover:text-purple-100">
                  <XMarkIcon className="w-3 h-3" aria-hidden="true" />
                </button>
              </span>
            );
          })}
          {selectedAccountIds.map((id) => {
            const account = accounts.find((a) => a.id === id);
            return (
              <span key={id} className="inline-flex items-center gap-1 px-2 py-1 bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 text-xs rounded-full">
                {account?.name ?? 'Unknown account'}
                <button onClick={() => setSelectedAccountIds(selectedAccountIds.filter((a) => a !== id))} className="hover:text-emerald-900 dark:hover:text-emerald-100">
                  <XMarkIcon className="w-3 h-3" aria-hidden="true" />
                </button>
              </span>
            );
          })}
          {selectedCategories.map((category) => (
            <span key={category.id} className="inline-flex items-center gap-1 px-2 py-1 bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 text-xs rounded-full">
              {(category.effectiveColor ?? category.color) && (
                <span
                  className="w-2 h-2 rounded-full flex-shrink-0"
                  style={{ backgroundColor: (category.effectiveColor ?? category.color)! }}
                />
              )}
              {category.name}
              <button onClick={() => setSelectedCategoryIds(selectedCategoryIds.filter((c) => c !== category.id))} className="hover:text-blue-900 dark:hover:text-blue-100">
                <XMarkIcon className="w-3 h-3" aria-hidden="true" />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Expanded filter controls */}
      {filtersExpanded && (
        <div className="px-4 pb-4 sm:px-6 space-y-4 border-t border-gray-200 dark:border-gray-700 pt-4">
          {/* The schedule type leads the panel, as the account status leads
              the register's. On a phone it takes the whole line and its
              segments share it. */}
          <div className="flex flex-wrap items-center gap-3">
            <span id="bills-filter-type-label" className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {tBills('viewTabs.filterLabel')}
            </span>
            <div
              role="group"
              aria-labelledby="bills-filter-type-label"
              className={SEGMENTED_TOOLBAR_GROUP_CLASS}
            >
              {TYPE_FILTERS.map((type) => (
                <button
                  key={type}
                  type="button"
                  onClick={() => setFilterType(type)}
                  aria-pressed={filterType === type}
                  className={toolbarSegmentClass(filterType === type)}
                >
                  {type === 'all'
                    ? tBills('viewTabs.filterAll', { count: typeCounts.all })
                    : type === 'bills'
                      ? tBills('viewTabs.filterBills', { count: typeCounts.bills })
                      : tBills('viewTabs.filterDeposits', { count: typeCounts.deposits })}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">{t('filters.nameLabel')}</label>
              <input
                type="text"
                value={nameSearch}
                onChange={(e) => setNameSearch(e.target.value)}
                placeholder={t('filters.namePlaceholder')}
                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
              />
            </div>
            <MultiSelect
              label={t('filters.payeesLabel')}
              options={payeeOptions}
              value={selectedPayeeIds}
              onChange={setSelectedPayeeIds}
              placeholder={t('filters.payeesPlaceholder')}
            />
            <MultiSelect
              label={t('filters.accountsLabel')}
              options={accountOptions}
              value={selectedAccountIds}
              onChange={setSelectedAccountIds}
              placeholder={t('filters.accountsPlaceholder')}
            />
            <MultiSelect
              label={t('filters.categoriesLabel')}
              options={categoryOptions}
              value={selectedCategoryIds}
              onChange={setSelectedCategoryIds}
              placeholder={t('filters.categoriesPlaceholder')}
            />
          </div>
        </div>
      )}
    </div>
  );
}
