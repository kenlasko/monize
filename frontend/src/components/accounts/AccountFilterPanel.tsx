'use client';

import { useTranslations } from 'next-intl';
import { XMarkIcon } from '@heroicons/react/24/outline';
import { Badge } from '@/components/ui/Badge';
import { useIsMobile } from '@/hooks/useIsMobile';
import { FilterPanelHeader } from '@/components/ui/FilterPanelHeader';
import { MultiSelect, MultiSelectOption } from '@/components/ui/MultiSelect';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  SEGMENTED_TOOLBAR_GROUP_CLASS,
  toolbarSegmentClass,
} from '@/components/ui/segmented-control';

export type AccountStatusFilter = 'active' | 'closed' | '';
export type AccountNetWorthFilter = 'included' | 'excluded' | '';
export type AccountJointFilter = 'joint' | '';

const CHIP_REMOVE_CLASS =
  'ml-0.5 -mr-1 p-0.5 rounded-full inline-flex items-center justify-center hover:bg-gray-200 dark:hover:bg-gray-600';

interface AccountFilterPanelProps {
  expanded: boolean;
  setExpanded: (expanded: boolean) => void;
  search: string;
  setSearch: (term: string) => void;
  status: AccountStatusFilter;
  setStatus: (status: AccountStatusFilter) => void;
  /** How many accounts each status segment holds, before any other filter. */
  statusCounts: { all: number; active: number; closed: number };
  types: string[];
  setTypes: (types: string[]) => void;
  typeOptions: MultiSelectOption[];
  netWorth: AccountNetWorthFilter;
  setNetWorth: (filter: AccountNetWorthFilter) => void;
  /** The net worth filter is offered only while some account is excluded. */
  showNetWorth: boolean;
  joint: AccountJointFilter;
  setJoint: (filter: AccountJointFilter) => void;
  /** The joint filter is offered only while something is shared to the reader. */
  showJoint: boolean;
  /** "3 of 10 accounts", drawn beside the expanded controls. */
  countLabel: string;
  onClear: () => void;
}

/**
 * How many of the panel's filters differ from the list's default view, for the
 * folded header's badge. The default status (Active) is not counted: it is the
 * view Clear returns to.
 */
export function countActiveAccountFilters(filters: {
  search: string;
  status: AccountStatusFilter;
  types: readonly string[];
  netWorth: AccountNetWorthFilter;
  joint: AccountJointFilter;
}): number {
  return (
    (filters.search.trim() ? 1 : 0) +
    (filters.status !== 'active' ? 1 : 0) +
    filters.types.length +
    (filters.netWorth ? 1 : 0) +
    (filters.joint ? 1 : 0)
  );
}

/**
 * The Accounts list's filters. On a phone they sit in the fold the Transactions
 * register and Bills use: `FilterPanelHeader` says how many apply and offers
 * Clear, and while it is folded each active filter stays on screen as a
 * removable chip, so folding the panel never hides what is narrowing the list.
 * Expanded, every control takes the full width of the phone's line. Wider
 * than a phone the controls fit one row and are always shown: there is no
 * fold, and a fold remembered on a phone-sized window does not apply.
 */
export function AccountFilterPanel(props: AccountFilterPanelProps) {
  const t = useTranslations('accounts');
  const {
    expanded,
    setExpanded,
    search,
    setSearch,
    status,
    setStatus,
    statusCounts,
    types,
    setTypes,
    typeOptions,
    netWorth,
    setNetWorth,
    showNetWorth,
    joint,
    setJoint,
    showJoint,
    countLabel,
    onClear,
  } = props;

  const activeCount = countActiveAccountFilters({ search, status, types, netWorth, joint });
  const foldable = useIsMobile();
  const showControls = !foldable || expanded;

  const chips: { key: string; label: string; onRemove: () => void }[] = [];
  if (search.trim()) {
    chips.push({ key: 'search', label: t('list.filter.chipSearch', { term: search.trim() }), onRemove: () => setSearch('') });
  }
  // Active is the default view, so it needs no chip; All or Closed does, and
  // removing it goes back to Active.
  if (status !== 'active') {
    chips.push({
      key: 'status',
      label: status === 'closed' ? t('list.filter.chipClosed') : t('list.filter.chipAll'),
      onRemove: () => setStatus('active'),
    });
  }
  for (const type of types) {
    chips.push({
      key: `type-${type}`,
      label: typeOptions.find((o) => o.value === type)?.label ?? type,
      onRemove: () => setTypes(types.filter((v) => v !== type)),
    });
  }
  if (netWorth) {
    chips.push({
      key: 'netWorth',
      label: netWorth === 'included' ? t('list.filter.inNetWorth') : t('list.filter.excludedFromNetWorth'),
      onRemove: () => setNetWorth(''),
    });
  }
  if (joint) {
    chips.push({ key: 'joint', label: t('list.filterJoint'), onRemove: () => setJoint('') });
  }

  return (
    <div className="px-3 sm:px-6 py-3 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800">
      {foldable && (
        <FilterPanelHeader
          expanded={expanded}
          count={activeCount}
          onToggle={() => setExpanded(!expanded)}
          onClear={onClear}
        />
      )}

      {!showControls && chips.length > 0 && (
        <div className="flex gap-2 mt-3 overflow-x-auto pb-1 -mx-3 px-3 sm:mx-0 sm:px-0 sm:flex-wrap sm:overflow-visible">
          {chips.map((chip) => (
            <Badge key={chip.key}>
              {chip.label}
              <button
                type="button"
                onClick={chip.onRemove}
                className={CHIP_REMOVE_CLASS}
                aria-label={t('list.filter.removeChip', { label: chip.label })}
              >
                <XMarkIcon className="w-3 h-3" aria-hidden="true" />
              </button>
            </Badge>
          ))}
        </div>
      )}

      {showControls && (
        // The status segments with their counts first, then the account type,
        // then the name search: the order the maintainer asked for on this
        // page (issue #2253), a deliberate exception to the list page's
        // search-first toolbar. On a phone each takes its own full-width line.
        <div className={`${foldable ? 'mt-3 ' : ''}flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center`}>
          <div role="group" aria-label={t('list.filter.statusLabel')} className={SEGMENTED_TOOLBAR_GROUP_CLASS}>
            {(
              [
                ['', t('list.filter.allCount', { count: statusCounts.all })],
                ['active', t('list.filter.activeCount', { count: statusCounts.active })],
                ['closed', t('list.filter.closedCount', { count: statusCounts.closed })],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value || 'all'}
                type="button"
                onClick={() => setStatus(value)}
                aria-pressed={status === value}
                className={toolbarSegmentClass(status === value)}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="w-full sm:w-52">
            <MultiSelect
              ariaLabel={t('list.filter.typeAriaLabel')}
              options={typeOptions}
              value={types}
              onChange={setTypes}
              placeholder={t('list.filter.typePlaceholder')}
              // A dozen account types at most: a search box only gets in the way.
              showSearch={false}
            />
          </div>

          <div className="relative w-full sm:w-52">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('list.filter.searchPlaceholder')}
              aria-label={t('list.filter.searchAriaLabel')}
              className="w-full text-sm font-sans border border-gray-300 dark:border-gray-600 rounded-md pl-3 pr-8 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 dark:placeholder-gray-400"
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                aria-label={t('list.filter.searchClear')}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200"
              >
                <XMarkIcon className="w-4 h-4" aria-hidden="true" />
              </button>
            )}
          </div>

          {showNetWorth && (
            <select
              value={netWorth}
              onChange={(e) => setNetWorth(e.target.value as AccountNetWorthFilter)}
              className="w-full sm:w-auto sm:min-w-[16rem] text-sm font-sans border border-gray-300 dark:border-gray-600 rounded-md px-3 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100"
            >
              <option value="">{t('list.filter.netWorthAll')}</option>
              <option value="included">{t('list.filter.inNetWorth')}</option>
              <option value="excluded">{t('list.filter.excludedFromNetWorth')}</option>
            </select>
          )}

          {/* The switch and its text are siblings, not nested: ToggleSwitch
              is a <button>, which a <label> cannot label. */}
          {showJoint && (
            <div className="inline-flex items-center gap-2 text-sm text-gray-700 dark:text-gray-300 whitespace-nowrap">
              <ToggleSwitch
                size="sm"
                checked={joint === 'joint'}
                onChange={(v) => setJoint(v ? 'joint' : '')}
                label={t('list.filterJoint')}
              />
              <span>{t('list.filterJoint')}</span>
            </div>
          )}

          <span className="text-sm text-gray-500 dark:text-gray-400 sm:ml-auto">{countLabel}</span>
        </div>
      )}
    </div>
  );
}
