'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import toast from 'react-hot-toast';
import { ReportDetailHeader } from '@/components/reports/ReportDetailHeader';
import { Button } from '@/components/ui/Button';
import { DateInput } from '@/components/ui/DateInput';
import { MultiSelect } from '@/components/ui/MultiSelect';
import { SortableHeader } from '@/components/ui/SortableHeader';
import { ReportToolbarActions } from '@/components/reports/ReportToolbarActions';
import { investmentReportsApi } from '@/lib/investment-reports';
import { accountsApi } from '@/lib/accounts';
import { Account } from '@/types/account';
import {
  InvestmentReport,
  InvestmentReportResult,
  InvestmentReportRow,
  InvestmentGroupBy,
  INVESTMENT_COLUMN_MAP,
  InvestmentColumnType,
  InvestmentCellValue,
} from '@/types/investment-report';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useSortableTable, compareValues } from '@/hooks/useSortableTable';
import { exportToCsv } from '@/lib/csv-export';
import { roundToCurrencyPlaces } from '@/lib/format';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';
import { useTranslations } from 'next-intl';
import { EmptyState } from '@/components/ui/EmptyState';
import { PartialTotal } from '@/components/ui/PartialTotal';
import type { ConvertedTotal } from '@/lib/currency-total';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';
import { useAccountPickerIcon } from '@/components/accounts/shared/AccountPickerIcon';
import { CARD_CLASS } from '@/components/ui/Card';

const logger = createLogger('InvestmentReportViewer');

const NUMERIC_TYPES: InvestmentColumnType[] = [
  'currency',
  'percent',
  'integer',
  'number',
  'shares',
];

interface InvestmentReportViewerProps {
  reportId: string;
}

export function InvestmentReportViewer({ reportId }: InvestmentReportViewerProps) {
  const t = useTranslations('reports');
  const tc = useTranslations('common');
  const router = useRouter();
  const { formatNumber, formatPercent, formatCurrency, formatQuantity } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const accountIcon = useAccountPickerIcon();
  const [report, setReport] = useState<InvestmentReport | null>(null);
  const [result, setResult] = useState<InvestmentReportResult | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isExecuting, setIsExecuting] = useState(false);
  // The last run failed. `result` keeps the run before it, which is not this
  // selection's answer, so it is not exportable.
  const [runFailed, setRunFailed] = useState(false);
  const [asOfOverride, setAsOfOverride] = useState('');
  // View-time account override. Seeded from the report's saved config (below,
  // once the report loads) but freely changeable without persisting.
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([]);
  const [seededReportId, setSeededReportId] = useState<string | null>(null);

  // Seed the account filter from the saved config the first time the report
  // (or a different report) loads. Done during render, not in an effect, so
  // the first execute already carries the saved accounts.
  if (report && seededReportId !== report.id) {
    setSeededReportId(report.id);
    setSelectedAccountIds(report.config.accountIds ?? []);
  }
  // Show monetary values in each holding's own currency, or convert to the
  // user's base currency.
  const [currencyMode, setCurrencyMode] = useState<'native' | 'base'>('native');

  const { sortField, sortDirection, handleSort } = useSortableTable<string>(
    'reports.investment.table.sort',
    { field: 'symbol', direction: 'asc' },
  );

  const groupHeadings: Record<InvestmentGroupBy, string> = {
    [InvestmentGroupBy.NONE]: t('investmentReportViewer.groupHeadingNone'),
    [InvestmentGroupBy.ACCOUNT]: t('investmentReportViewer.groupHeadingAccount'),
    [InvestmentGroupBy.SYMBOL]: t('investmentReportViewer.groupHeadingSymbol'),
    [InvestmentGroupBy.CURRENCY]: t('investmentReportViewer.groupHeadingCurrency'),
  };

  const loadReport = useCallback(async () => {
    try {
      const data = await investmentReportsApi.getById(reportId);
      setReport(data);
    } catch (error) {
      toast.error(getErrorMessage(error, t('investmentReportViewer.toasts.loadFailed')));
      logger.error(error);
    }
  }, [reportId, t]);

  // The inputs the report last ran for. When they change, the "becomes
  // executing" transition happens here, during render, rather than from inside
  // the effect that sends the request.
  const [executeInputs, setExecuteInputs] = useState({
    reportId,
    report,
    asOfOverride,
    selectedAccountIds,
  });
  if (
    executeInputs.reportId !== reportId ||
    executeInputs.report !== report ||
    executeInputs.asOfOverride !== asOfOverride ||
    executeInputs.selectedAccountIds !== selectedAccountIds
  ) {
    setExecuteInputs({ reportId, report, asOfOverride, selectedAccountIds });
    if (report) setIsExecuting(true);
  }

  const runReport = useCallback(() => {
    // The state writes live in this inner function so they run once the
    // request settles, never synchronously inside the effect that calls this.
    const run = async () => {
      try {
        const data = await investmentReportsApi.execute(reportId, {
          ...(asOfOverride ? { asOfDate: asOfOverride } : {}),
          accountIds: selectedAccountIds,
        });
        setResult(data);
        setRunFailed(false);
      } catch (error) {
        setRunFailed(true);
        toast.error(getErrorMessage(error, t('investmentReportViewer.toasts.runFailed')));
        logger.error(error);
      } finally {
        setIsExecuting(false);
      }
    };
    return run();
  }, [reportId, asOfOverride, selectedAccountIds, t]);

  // Every run other than the automatic one shows the spinner itself.
  const executeReport = useCallback(() => {
    setIsExecuting(true);
    return runReport();
  }, [runReport]);

  useEffect(() => {
    const init = async () => {
      setIsLoading(true);
      await Promise.all([
        loadReport(),
        accountsApi
          .getAll()
          .then((all) =>
            setAccounts(
              all.filter(
                (a) =>
                  a.accountType === 'INVESTMENT' &&
                  a.accountSubType !== 'INVESTMENT_CASH' &&
                  !a.isClosed,
              ),
            ),
          )
          .catch((error) => logger.error('Failed to load accounts:', error)),
      ]);
      setIsLoading(false);
    };
    init();
  }, [loadReport]);

  useEffect(() => {
    if (!report) return;
    runReport();
  }, [report, runReport]);

  const formatCell = (
    value: InvestmentCellValue,
    type: InvestmentColumnType,
    row: InvestmentReportRow,
  ): string => {
    if (value === null || value === undefined || value === '') return '—';
    switch (type) {
      case 'currency': {
        const num = Number(value);
        // Native values are in the holding's currency; convert to base when toggled.
        if (currencyMode === 'base' && result) {
          // No rate for this row's pair: the base-currency value is unknown.
          // `num * null` would render it as 0.00 -- a confident wrong number.
          if (row.baseExchangeRate === null) return '—';
          return formatCurrency(num * row.baseExchangeRate, result.baseCurrency);
        }
        const formatted = formatCurrency(num, row.currency);
        // Match other pages: append the ISO code only for non-base currencies
        // (e.g. "$99,999.99 USD") so they aren't mistaken for the base currency.
        return result && row.currency !== result.baseCurrency
          ? `${formatted} ${row.currency}`
          : formatted;
      }
      case 'number':
        return formatNumber(Number(value), 4);
      case 'integer':
        return formatNumber(Number(value), 0);
      case 'percent':
        return formatPercent(Number(value), 2);
      case 'shares':
        return formatQuantity(Number(value));
      case 'date':
        return formatDate(String(value));
      default:
        return String(value);
    }
  };

  const sortRows = (rows: InvestmentReportRow[]): InvestmentReportRow[] => {
    return [...rows].sort((a, b) => {
      const av = a.values[sortField];
      const bv = b.values[sortField];
      if (av === null && bv === null) return 0;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      const cmp = compareValues(av, bv);
      return sortDirection === 'asc' ? cmp : -cmp;
    });
  };

  const handleExportCsv = () => {
    if (!result) return;
    const cols = result.columns;
    const grouped = result.groupBy !== InvestmentGroupBy.NONE;
    const headers = [
      ...(grouped ? [groupHeadings[result.groupBy]] : []),
      ...cols.map((key) => INVESTMENT_COLUMN_MAP[key]?.label ?? key),
    ];
    const rows = result.groups.flatMap((g) =>
      g.rows.map((row) => [
        ...(grouped ? [g.label] : []),
        ...cols.map((key) => {
          const v = row.values[key];
          if (v === null || v === undefined) return '';
          // Mirror the on-screen currency mode in the exported numbers,
          // including the unknown marker for a row with no rate to base. The
          // product is a figure the client works out, so it is rounded once at
          // the base currency's places, the figure the cell shows.
          if (
            currencyMode === 'base' &&
            INVESTMENT_COLUMN_MAP[key]?.type === 'currency'
          ) {
            return row.baseExchangeRate === null
              ? ''
              : roundToCurrencyPlaces(Number(v) * row.baseExchangeRate, result.baseCurrency);
          }
          return v;
        }),
      ]),
    );
    const filename = `${report?.name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase() || 'investment-report'}`;
    exportToCsv(filename, headers, rows);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  if (!report) {
    return (
      <EmptyState
        title={t('investmentReportViewer.notFound')}
        action={
          <Button variant="outline" onClick={() => router.push('/reports')}>
            {t('detailHeader.backToReports')}
          </Button>
        }
      />
    );
  }

  const columns = result?.columns ?? [];

  // `=== false` on purpose: an absent flag is no information, not a claim that
  // every pair resolved.
  const fxPartial = result?.fxComplete === false;
  const missingPairs = result?.missingPairs ?? [];
  // The other cause of the same blanks, and a different repair: an unpriced
  // holding withholds the denominator exactly as a missing rate does, so it is
  // named on its own rather than under the exchange-rate caption.
  const pricesPartial = result?.pricesComplete === false;
  const unpricedSymbols = result?.unpricedSymbols ?? [];
  // The pairs the server refused, in the shape PartialTotal explains: each
  // pair's source currency is the one with no rate to the base currency.
  const fxGap: ConvertedTotal = {
    value: 0,
    missingCurrencies: missingPairs.map((pair) => pair.split('->')[0]),
    excludedCount: missingPairs.length,
  };

  return (
    <div className="space-y-6">
      <ReportDetailHeader
        reportId={`investment/${reportId}`}
        title={report.name}
        subtitle={report.description ?? undefined}
        actions={
          <Button
            variant="outline"
            className="shrink-0"
            onClick={() => router.push(`/reports/investment/${reportId}/edit`)}
          >
            {tc('edit')}
          </Button>
        }
      />

      {/* Controls */}
      <div className={`${CARD_CLASS} p-4 sm:p-6`}>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="flex flex-wrap items-end gap-4">
            <div className="w-56">
              <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('investmentReportViewer.accountsLabel')}
              </span>
              <MultiSelect
                ariaLabel={t('investmentReportViewer.accountsLabel')}
                placeholder={t('investmentReportViewer.accountsPlaceholder')}
                options={accounts.map((a) => ({ value: a.id, label: a.name, icon: accountIcon(a) }))}
                value={selectedAccountIds}
                onChange={setSelectedAccountIds}
              />
            </div>
            <div className="w-48">
              <DateInput
                label={t('investmentReportViewer.labelAsOfDate')}
                value={asOfOverride}
                onChange={(e) => setAsOfOverride(e.target.value)}
                onDateChange={(date) => setAsOfOverride(date)}
              />
            </div>
            <div>
              <span className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                {t('investmentReportViewer.currencyLabel')}
              </span>
              <div
                className={SEGMENTED_GROUP_CLASS}
                role="group"
                aria-label={t('investmentReportViewer.currencyLabel')}
              >
                <button
                  type="button"
                  onClick={() => setCurrencyMode('native')}
                  aria-pressed={currencyMode === 'native'}
                  className={segmentClass(currencyMode === 'native')}
                >
                  {t('investmentReportViewer.currencyNative')}
                </button>
                <button
                  type="button"
                  onClick={() => setCurrencyMode('base')}
                  aria-pressed={currencyMode === 'base'}
                  className={segmentClass(currencyMode === 'base')}
                >
                  {result?.baseCurrency || 'Base'}
                </button>
              </div>
            </div>
          </div>
          {/* CSV only: a custom report is rows, and the viewer draws no chart
              to put in a PDF. */}
          <ReportToolbarActions
            onRefreshComplete={executeReport}
            onExportCsv={handleExportCsv}
            disabled={isExecuting || runFailed || !result || result.rowCount === 0}
            className="sm:self-auto"
          />
        </div>
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          {asOfOverride ? (
            <button
              type="button"
              className="text-blue-600 dark:text-blue-400 hover:underline"
              onClick={() => setAsOfOverride('')}
            >
              {t('investmentReportViewer.resetToLatest')}
            </button>
          ) : (
            t('investmentReportViewer.showingLatest')
          )}
          {' · '}
          {currencyMode === 'base' && result
            ? t('investmentReportViewer.baseNote', { currency: result.baseCurrency })
            : t('investmentReportViewer.nativeNote')}
        </p>
        {/* A withheld figure is relabelled where it is read, not only logged on
            the server: one unresolvable pair blanks every row's % of portfolio,
            and without this the blanks read as zero. Marked through the same
            PartialTotal the other reports use, so the marker names the pairs. */}
        {fxPartial && result && (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
            <PartialTotal total={fxGap} displayCurrency={result.baseCurrency}>
              {t('investmentReportViewer.partialFxNote', {
                pairs: (result.missingPairs ?? []).join(', '),
              })}
            </PartialTotal>
          </p>
        )}
        {/* Both causes are shown when both apply: naming one makes the reader
            fix it and watch nothing change. */}
        {pricesPartial && result && (
          <p className="mt-1 text-xs text-amber-700 dark:text-amber-400">
            {t('investmentReportViewer.partialPriceNote', {
              symbols: unpricedSymbols.join(', '),
            })}
          </p>
        )}
      </div>

      {/* Results */}
      {isExecuting && !result ? (
        <div className={`${CARD_CLASS} p-12`}>
          <div className="flex flex-col items-center justify-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mb-4"></div>
            <p className="text-gray-500 dark:text-gray-400">{t('investmentReportViewer.generating')}</p>
          </div>
        </div>
      ) : result ? (
        <div className={`${CARD_CLASS} p-4 sm:p-6`}>
          <div className="flex items-center justify-between mb-4">
            <span className="text-sm text-gray-500 dark:text-gray-400">
              {t('investmentReportViewer.asOf', { date: formatDate(result.asOfDate) })} · {t('investmentReportViewer.holdingCount', { count: result.rowCount })}
            </span>
            {isExecuting && (
              <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400">
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
                <span>{t('investmentReportViewer.updating')}</span>
              </div>
            )}
          </div>

          {result.rowCount === 0 ? (
            <div className="py-12 text-center text-gray-500 dark:text-gray-400">
              {t('investmentReportViewer.noHoldings')}
            </div>
          ) : (
            <div className="overflow-x-auto">
              {/* A single table (one header, one tbody per group) so every group
                  shares the same column widths and lines up vertically. */}
              <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
                <thead className="bg-gray-50 dark:bg-gray-900/50">
                  <tr>
                    {columns.map((key) => {
                      const col = INVESTMENT_COLUMN_MAP[key];
                      const numeric = col && NUMERIC_TYPES.includes(col.type);
                      return (
                        <SortableHeader<string>
                          key={key}
                          field={key}
                          sortField={sortField}
                          sortDirection={sortDirection}
                          onSort={handleSort}
                          align={numeric ? 'right' : 'left'}
                          className="px-3 py-2 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase whitespace-nowrap"
                        >
                          {col?.label ?? key}
                        </SortableHeader>
                      );
                    })}
                  </tr>
                </thead>
                {result.groups.map((group) => (
                  <tbody
                    key={group.key}
                    className="divide-y divide-gray-200 dark:divide-gray-700"
                  >
                    {result.groupBy !== InvestmentGroupBy.NONE && (
                      <tr className="bg-gray-50 dark:bg-gray-900/40">
                        <td
                          colSpan={columns.length}
                          className="px-3 py-2 text-sm font-semibold text-gray-900 dark:text-gray-100"
                        >
                          {group.label || t('investmentReportViewer.ungrouped')}
                        </td>
                      </tr>
                    )}
                    {sortRows(group.rows).map((row) => (
                      <tr
                        key={row.id}
                        className="hover:bg-gray-50 dark:hover:bg-gray-700/50"
                      >
                        {columns.map((key) => {
                          const col = INVESTMENT_COLUMN_MAP[key];
                          const numeric = col && NUMERIC_TYPES.includes(col.type);
                          return (
                            <td
                              key={key}
                              className={`px-3 py-2 text-sm whitespace-nowrap ${
                                numeric
                                  ? 'text-right text-gray-900 dark:text-gray-100'
                                  : 'text-gray-700 dark:text-gray-300'
                              }`}
                            >
                              {formatCell(row.values[key], col?.type ?? 'text', row)}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                ))}
              </table>
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

