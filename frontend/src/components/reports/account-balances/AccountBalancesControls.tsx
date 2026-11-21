'use client';

import { useTranslations } from 'next-intl';
import { DateInput } from '@/components/ui/DateInput';
import { Select } from '@/components/ui/Select';
import { MultiSelect, type MultiSelectOption } from '@/components/ui/MultiSelect';
import { ChartViewToggle } from '@/components/ui/ChartViewToggle';
import { ReportToolbarActions } from '@/components/reports/ReportToolbarActions';
import { LabelSpacer } from '@/components/ui/LabelSpacer';
import {
  GROUP_BY_OPTIONS,
  SORT_BY_OPTIONS,
  type AccountBalanceFilters,
  type BalanceScope,
  type FavouriteFilter,
  type GroupBy,
  type SortBy,
  type SortDirection,
  type StatusFilter,
} from './grouping';
import { CARD_CLASS } from '@/components/ui/Card';

export type ViewMode = 'table' | 'chart';

interface Props {
  asOfDate: string;
  onAsOfDateChange: (date: string) => void;
  filters: AccountBalanceFilters;
  onFiltersChange: (filters: AccountBalanceFilters) => void;
  institutionOptions: MultiSelectOption[];
  accountTypeOptions: MultiSelectOption[];
  groupBy: GroupBy;
  onGroupByChange: (groupBy: GroupBy) => void;
  sortBy: SortBy;
  onSortByChange: (sortBy: SortBy) => void;
  sortDirection: SortDirection;
  onSortDirectionToggle: () => void;
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onExportPdf: () => void;
  onExportCsv: () => void;
}

const SCOPES: BalanceScope[] = ['all', 'assets', 'liabilities'];

/**
 * The report's toolbar: the date the balances are measured at, what is
 * included, how it is grouped and how it is ordered (issue #1198).
 *
 * Split out of the report so the component that renders the figures is not also
 * the component that owns nine pieces of control state.
 */
export function AccountBalancesControls({
  asOfDate,
  onAsOfDateChange,
  filters,
  onFiltersChange,
  institutionOptions,
  accountTypeOptions,
  groupBy,
  onGroupByChange,
  sortBy,
  onSortByChange,
  sortDirection,
  onSortDirectionToggle,
  viewMode,
  onViewModeChange,
  onExportPdf,
  onExportCsv,
}: Props) {
  const t = useTranslations('reports');

  const groupByOptions = GROUP_BY_OPTIONS.map((value) => ({
    value,
    label: t(`accountBalances.groupBy${value.charAt(0).toUpperCase()}${value.slice(1)}` as Parameters<typeof t>[0]),
  }));
  const sortByOptions = SORT_BY_OPTIONS.map((value) => ({
    value,
    label: t(`accountBalances.sortBy${value.charAt(0).toUpperCase()}${value.slice(1)}` as Parameters<typeof t>[0]),
  }));

  return (
    <div className={`${CARD_CLASS} p-4 space-y-4`}>
      {/* Every control is as wide as the row lets it be. A `<select>` clips its
          text rather than ellipsing it, so a fixed width is a promise about the
          longest option's length in every language -- one the translations
          break. The grid gives each control an equal share of the full row and
          drops to fewer columns before any of them gets narrow. */}
      {/* The fields and the actions column are two cells of one CSS grid row,
          not two flex items -- `align-items: stretch` is grid's default, so
          both cells are pulled to the row's own height (the fields' 66px:
          label + gap + input) with no explicit number written down anywhere.
          A flex row with `items-end` only lines up bottoms; it does not equalize
          height, which is how the view toggle and export button ended up a
          visibly shorter 36px sitting flush against the same baseline -- close
          enough to pass a glance, wrong on measurement. Below `lg` the two
          cells stack into their own rows (nothing to stretch against, and
          nothing beside them to look mismatched against either). */}
      <div className="grid grid-cols-1 items-stretch gap-4 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="grid min-w-0 grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <DateInput
            label={t('accountBalances.asOfDate')}
            value={asOfDate}
            onDateChange={onAsOfDateChange}
            data-testid="as-of-date"
          />
          <Select
            label={t('accountBalances.groupByLabel')}
            value={groupBy}
            onChange={(e) => onGroupByChange(e.target.value as GroupBy)}
            options={groupByOptions}
          />
          {/* The direction toggle is the height of the field beside it, and it
              gets there without a magic number: the row stretches both columns,
              and this column reserves the same label space above the button as
              `Select` renders above its input, so what is left to stretch into
              is exactly the input's height. `self-stretch` alone measured from
              the top of the label and stood a label taller. */}
          <div className="flex items-stretch gap-2">
            <div className="min-w-0 flex-1">
              <Select
                label={t('accountBalances.sortByLabel')}
                value={sortBy}
                onChange={(e) => onSortByChange(e.target.value as SortBy)}
                options={sortByOptions}
              />
            </div>
            <div className="flex flex-col">
              <LabelSpacer />
              <button
                type="button"
                onClick={onSortDirectionToggle}
                aria-label={
                  sortDirection === 'asc'
                    ? t('accountBalances.sortAscending')
                    : t('accountBalances.sortDescending')
                }
                title={
                  sortDirection === 'asc'
                    ? t('accountBalances.sortAscending')
                    : t('accountBalances.sortDescending')
                }
                className="flex-1 rounded-md border border-gray-300 px-3 text-gray-600 transition-colors hover:bg-gray-100 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
              >
                {sortDirection === 'asc' ? '↑' : '↓'}
              </button>
            </div>
          </div>
        </div>
        {/* The view toggle and the export button are controls on a row of
            labelled fields, so from `sm` up they take the fields' height the
            same way the sort-direction button does: the label's space is
            reserved above them, and what is left is stretched into. They were
            previously a hand-rolled pair of icon buttons centred against the
            row, which stood short of every field beside them --
            `ChartViewToggle` is the component 19 other surfaces use for exactly
            this. On a phone there is no field beside them, so the reserved
            space goes and the export takes a line of its own. */}
        <div className="flex flex-col">
          <div className="hidden sm:block">
            <LabelSpacer />
          </div>
          <div className="flex flex-1 flex-wrap items-stretch gap-2">
            <ChartViewToggle
              value={viewMode === 'chart' ? 'pie' : 'table'}
              onChange={(view) => onViewModeChange(view === 'pie' ? 'chart' : 'table')}
              options={['table', 'pie']}
            />
            <ReportToolbarActions
              onExportPdf={onExportPdf}
              onExportCsv={onExportCsv}
              className="sm:ml-0"
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-5">
        <div>
          <Select
            label={t('accountBalances.scopeLabel')}
            value={filters.scope}
            onChange={(e) =>
              onFiltersChange({ ...filters, scope: e.target.value as BalanceScope })
            }
            options={SCOPES.map((scope) => ({
              value: scope,
              label: t(
                `accountBalances.scope${scope.charAt(0).toUpperCase()}${scope.slice(1)}` as Parameters<
                  typeof t
                >[0],
              ),
            }))}
          />
        </div>
        <div>
          <MultiSelect
            label={t('accountBalances.institutionsLabel')}
            options={institutionOptions}
            value={filters.institutionKeys}
            onChange={(institutionKeys) => onFiltersChange({ ...filters, institutionKeys })}
            placeholder={t('accountBalances.institutionsPlaceholder')}
          />
        </div>
        <div>
          <MultiSelect
            label={t('accountBalances.accountTypesLabel')}
            options={accountTypeOptions}
            value={filters.accountTypes}
            onChange={(accountTypes) => onFiltersChange({ ...filters, accountTypes })}
            placeholder={t('accountBalances.accountTypesPlaceholder')}
          />
        </div>
        <div>
          <Select
            label={t('accountBalances.statusLabel')}
            value={filters.status}
            onChange={(e) =>
              onFiltersChange({ ...filters, status: e.target.value as StatusFilter })
            }
            options={[
              { value: 'open', label: t('accountBalances.statusOpen') },
              { value: 'closed', label: t('accountBalances.statusClosed') },
              { value: 'all', label: t('accountBalances.statusAll') },
            ]}
          />
        </div>
        <div>
          <Select
            label={t('accountBalances.favouritesLabel')}
            value={filters.favourite}
            onChange={(e) =>
              onFiltersChange({ ...filters, favourite: e.target.value as FavouriteFilter })
            }
            options={[
              { value: 'all', label: t('accountBalances.favouritesAll') },
              { value: 'favourites', label: t('accountBalances.favouritesOnly') },
              { value: 'others', label: t('accountBalances.favouritesOthers') },
            ]}
          />
        </div>
      </div>
    </div>
  );
}
