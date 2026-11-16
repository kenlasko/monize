'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import { Badge, type BadgeVariant } from '@/components/ui/Badge';
import { CARD_CLASS } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/EmptyState';
import { ListBottomPager } from '@/components/ui/ListBottomPager';
import { LIST_TOOLBAR_BUTTON_CLASS, ListTopToolbar } from '@/components/ui/ListTopToolbar';
import { SortableTh, TABLE_BODY_CLASS, TABLE_CLASS, Td } from '@/components/ui/Table';
import {
  SEGMENTED_TOOLBAR_GROUP_CLASS,
  toolbarSegmentClass,
} from '@/components/ui/segmented-control';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { PAGE_SIZE } from '@/lib/constants';
import { exportToCsv } from '@/lib/csv-export';
import {
  RATE_SORT_FIELDS,
  countRateSourceGroups,
  rateDisplayDecimals,
  filterRateRows,
  sortRateRows,
  type RateHistoryRow,
  type RateSortDirection,
  type RateSortField,
  type RateSourceFilter,
  type RateSourceGroup,
} from '@/lib/currency-detail';
import { useRateSourceLabel } from './useRateSourceLabel';

interface CurrencyRateTableProps {
  code: string;
  defaultCurrency: string;
  /** The rows of the selected period. */
  rows: readonly RateHistoryRow[];
  /**
   * Whether the pair has any rate at all, in or out of the period: an empty
   * period then says so, rather than reading as a pair with no history.
   * Defaults to whether `rows` holds one.
   */
  hasAnyRates?: boolean;
  /** Lines under the table saying what a bounded read left out. */
  notes?: readonly string[];
  /**
   * The source filter, when a parent keeps it: the detail page replaces the
   * table with a spinner while it re-reads the history after a fill, and a
   * filter held here would be reset to All by that.
   */
  filter?: RateSourceFilter;
  onFilterChange?: (filter: RateSourceFilter) => void;
}

/** The filter segments, in order; Other only when it holds a row. */
const FILTERS: readonly RateSourceFilter[] = ['all', 'yahoo', 'frankfurter', 'transaction', 'other'];

const GROUP_BADGE: Record<RateSourceGroup, BadgeVariant> = {
  yahoo: 'purple',
  frankfurter: 'blue',
  // The chart draws the reader's own rates in amber; the badge matches.
  transaction: 'amber',
  other: 'gray',
};

/**
 * Every rate the page knows for the pair in the selected period, a page at a
 * time: the provider's stored history and the rates the reader's own
 * transactions settled at, in one list the reader can sort by any column,
 * narrow to one source and export.
 */
export function CurrencyRateTable({
  code,
  defaultCurrency,
  rows,
  hasAnyRates = rows.length > 0,
  notes = [],
  filter: controlledFilter,
  onFilterChange,
}: CurrencyRateTableProps) {
  const t = useTranslations('currencyDetail');
  const { formatDate } = useDateFormat();
  const { formatNumber } = useNumberFormat();
  const sourceLabel = useRateSourceLabel();

  const [localFilter, setLocalFilter] = useState<RateSourceFilter>('all');
  const filter = controlledFilter ?? localFilter;
  const [sortField, setSortField] = useLocalStorage<RateSortField>(
    'monize-currency-rates-sort-field',
    'date',
  );
  const [sortDirection, setSortDirection] = useLocalStorage<RateSortDirection>(
    'monize-currency-rates-sort-dir',
    'desc',
  );
  const [currentPage, setCurrentPage] = useState(1);

  // A new period starts from its first page ("info from previous render").
  const [pagedRows, setPagedRows] = useState(rows);
  if (pagedRows !== rows) {
    setPagedRows(rows);
    setCurrentPage(1);
  }

  // A remembered field this table no longer has falls back to the date.
  const activeSortField: RateSortField = RATE_SORT_FIELDS.includes(sortField) ? sortField : 'date';

  const counts = useMemo(() => countRateSourceGroups(rows), [rows]);
  const visibleFilters = FILTERS.filter((key) => key !== 'other' || counts.other > 0);
  const activeFilter: RateSourceFilter = visibleFilters.includes(filter) ? filter : 'all';

  // What a transaction row was, in words: its kind, then the payee and the
  // account it was posted to. Empty for a provider row.
  const describeRow = (row: RateHistoryRow): string => {
    if (!row.transaction) return '';
    const { kind, payeeName, accountName } = row.transaction;
    // A transfer leg's payee is the transfer itself ("Transfer to ..."),
    // which would only repeat the kind.
    return payeeName && kind !== 'transfer'
      ? t('table.detailWithPayee', { kind: t(`table.kinds.${kind}`), payee: payeeName, account: accountName })
      : t('table.detail', { kind: t(`table.kinds.${kind}`), account: accountName });
  };

  const sorted = useMemo(
    () =>
      sortRateRows(filterRateRows(rows, activeFilter), activeSortField, sortDirection, (row) =>
        sourceLabel(row.source),
      ),
    [rows, activeFilter, activeSortField, sortDirection, sourceLabel],
  );

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const page = Math.min(currentPage, totalPages);
  const pageRows = sorted.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const handleSort = (field: RateSortField) => {
    if (field === activeSortField) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      // A date reads newest first; every other column from the smallest.
      setSortDirection(field === 'date' ? 'desc' : 'asc');
    }
    setCurrentPage(1);
  };

  const handleFilter = (next: RateSourceFilter) => {
    setLocalFilter(next);
    onFilterChange?.(next);
    setCurrentPage(1);
  };

  const rateHeader = t('table.columns.rate', { code, currency: defaultCurrency });
  const inverseHeader = t('table.columns.inverseRate', { code, currency: defaultCurrency });

  const handleExport = () => {
    exportToCsv(
      t('table.exportFilename', { code, currency: defaultCurrency }),
      [
        t('table.columns.date'),
        rateHeader,
        inverseHeader,
        t('table.columns.source'),
        t('table.columns.details'),
      ],
      sorted.map((row) => [
        row.date,
        row.rate,
        row.inverseRate,
        sourceLabel(row.source),
        describeRow(row),
      ]),
    );
  };

  const formatRate = (rate: number | null) =>
    rate === null ? (
      <span className="text-gray-400 dark:text-gray-500">{t('table.unknownRate')}</span>
    ) : (
      formatNumber(rate, rateDisplayDecimals(rate))
    );

  const sortProps = { sortField: activeSortField, sortDirection, onSort: handleSort };
  const itemName = t('table.itemName');

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div role="group" aria-label={t('table.filterAriaLabel')} className={SEGMENTED_TOOLBAR_GROUP_CLASS}>
          {visibleFilters.map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => handleFilter(key)}
              aria-pressed={activeFilter === key}
              className={toolbarSegmentClass(activeFilter === key)}
            >
              {t(`table.filters.${key}`, { count: formatNumber(counts[key], 0) })}
            </button>
          ))}
        </div>
      </div>

      <div className={`${CARD_CLASS} overflow-hidden`}>
        {sorted.length > 0 && (
          <ListTopToolbar
            currentPage={page}
            totalPages={totalPages}
            totalItems={sorted.length}
            pageSize={PAGE_SIZE}
            onPageChange={setCurrentPage}
            itemName={itemName}
            actions={
              <button type="button" onClick={handleExport} className={LIST_TOOLBAR_BUTTON_CLASS}>
                <ArrowDownTrayIcon className="mr-1 h-4 w-4" aria-hidden="true" />
                {t('table.export')}
              </button>
            }
          />
        )}
        {sorted.length === 0 ? (
          <EmptyState
            title={
              !hasAnyRates
                ? t('table.empty.title')
                : rows.length === 0
                  ? t('table.empty.periodTitle')
                  : t('table.empty.filteredTitle')
            }
            description={
              !hasAnyRates
                ? t('table.empty.description', { code, currency: defaultCurrency })
                : undefined
            }
            help="currencyRateHistory"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className={TABLE_CLASS}>
              <thead className="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <SortableTh {...sortProps} field="date">
                    {t('table.columns.date')}
                  </SortableTh>
                  <SortableTh {...sortProps} field="rate" align="right" className="whitespace-nowrap">
                    {rateHeader}
                  </SortableTh>
                  <SortableTh
                    {...sortProps}
                    field="inverseRate"
                    align="right"
                    className="hidden whitespace-nowrap sm:table-cell"
                  >
                    {inverseHeader}
                  </SortableTh>
                  <SortableTh {...sortProps} field="source">
                    {t('table.columns.source')}
                  </SortableTh>
                </tr>
              </thead>
              <tbody className={`bg-white dark:bg-gray-900 ${TABLE_BODY_CLASS}`}>
                {pageRows.map((row) => (
                  <tr key={row.key}>
                    <Td className="whitespace-nowrap">{formatDate(row.date)}</Td>
                    <Td align="right" className="whitespace-nowrap">
                      {formatRate(row.rate)}
                    </Td>
                    <Td align="right" className="hidden whitespace-nowrap sm:table-cell">
                      {formatRate(row.inverseRate)}
                    </Td>
                    <Td>
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <Badge variant={GROUP_BADGE[row.group]}>{sourceLabel(row.source)}</Badge>
                        {row.transaction && (
                          <span className="text-xs text-gray-500 dark:text-gray-400">
                            {describeRow(row)}
                          </span>
                        )}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ListBottomPager
        currentPage={page}
        totalPages={totalPages}
        totalItems={sorted.length}
        pageSize={PAGE_SIZE}
        onPageChange={setCurrentPage}
        itemName={itemName}
        totalLabel={t('table.totalLabel', { count: sorted.length })}
      />

      {notes.map((note) => (
        <p key={note} className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {note}
        </p>
      ))}
    </div>
  );
}
