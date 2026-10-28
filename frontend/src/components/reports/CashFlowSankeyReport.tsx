'use client';

import { useReportExportMetadata } from '@/hooks/useReportExportMetadata';
import { useMemo, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { accountsApi } from '@/lib/accounts';
import { categoriesApi } from '@/lib/categories';
import type { ConvertedTotal } from '@/lib/currency-total';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useDateRange } from '@/hooks/useDateRange';
import { useReportData } from '@/hooks/useReportData';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { Skeleton } from '@/components/ui/LoadingSkeleton';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ChartViewToggle } from '@/components/ui/ChartViewToggle';
import { ChartLegend } from '@/components/ui/ChartLegend';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { EmptyState } from '@/components/ui/EmptyState';
import { SEGMENTED_GROUP_CLASS, segmentClass } from '@/components/ui/segmented-control';
import { CAPTION_CLASS, CellLabel, TABLE_BODY_CLASS, TABLE_CLASS } from '@/components/ui/Table';
import { Card, CARD_CLASS, HOVER_ROW_ON_CARD } from '@/components/ui/Card';
import { INTERACTIVE_ROW_FOCUS_CLASS, activateOnKey } from '@/components/ui/interactive-row';
import { ReportToolbarActions } from '@/components/reports/ReportToolbarActions';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { ReportError } from '@/components/reports/ReportError';
import { IncompleteDataDetails } from '@/components/reports/IncompleteDataDetails';
import {
  CashFlowSankeyDiagram,
  sankeyNodeHref,
  sankeyTableRows,
  useSankeyNodePresentation,
  type FlowSide,
} from '@/components/reports/CashFlowSankeyDiagram';
import type {
  CashFlowSankeyDepth,
  CashFlowSankeyNode,
} from '@/types/built-in-reports';

type SankeyView = 'sankey' | 'table';

const NO_IDS: string[] = [];

/**
 * The report's settings, kept in this browser so returning to the report
 * draws it as it was left. Settings only: the range, the depth, the view and
 * the scope's account ids, never a figure.
 */
export const SANKEY_STORAGE_KEYS = {
  range: 'monize-reports-cash-flow-sankey-range',
  depth: 'monize-reports-cash-flow-sankey-depth',
  view: 'monize-reports-cash-flow-sankey-view',
  accounts: 'monize-reports-cash-flow-sankey-accounts',
} as const;

// A stored value is whatever the browser hands back, so each is read through
// a check of its shape: a hand-edited or stale entry falls back to the
// default rather than reaching a request.
const asDepth = (value: unknown): CashFlowSankeyDepth => (value === 2 ? 2 : 1);
const asView = (value: unknown): SankeyView | null =>
  value === 'sankey' || value === 'table' ? value : null;
const asAccountIds = (value: unknown): string[] | null =>
  Array.isArray(value) && value.length > 0 && value.every((id) => typeof id === 'string')
    ? value
    : null;

// The table's phone layout, as the sibling reports write it: the flow's name
// takes line 1, its side and its amount split line 2. From `sm` up each row is
// a table row again.
const ROW_GRID =
  'grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-start gap-x-3 gap-y-1.5 px-4 py-3';
const IDENTITY_CELL =
  'col-start-1 col-span-2 row-start-1 min-w-0 p-0 text-sm sm:table-cell sm:px-4 sm:py-3';
const SIDE_CELL =
  'col-start-1 row-start-2 p-0 text-xs text-gray-600 dark:text-gray-400 sm:table-cell sm:px-4 sm:py-3 sm:text-sm';
const FIGURE_CELL =
  'col-start-2 row-start-2 p-0 text-right text-xs whitespace-nowrap sm:table-cell sm:px-4 sm:py-3 sm:text-sm';
const HEADER_CLASS =
  'px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase';

export function CashFlowSankeyReport() {
  const { exportSectionsWithBasis, withPdfBasis } = useReportExportMetadata('cash');
  const t = useTranslations('reports');
  const router = useRouter();
  const chartRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const { formatCurrency, formatCurrencyCompact } = useNumberFormat();
  const { formatDate } = useDateFormat();
  const { defaultCurrency } = useExchangeRates();

  // A phone reads the table; the diagram's columns do not reflow (decision
  // 11). A choice the reader made, kept from their last visit, wins over the
  // default either way.
  const [storedView, setChosenView] = useLocalStorage<SankeyView | null>(SANKEY_STORAGE_KEYS.view, null);
  const view: SankeyView = asView(storedView) ?? (isMobile ? 'table' : 'sankey');
  const [storedDepth, setDepth] = useLocalStorage<CashFlowSankeyDepth>(SANKEY_STORAGE_KEYS.depth, 1);
  const depth = asDepth(storedDepth);
  // `null` until the reader picks: the server's default cash-flow scope, which
  // the picker then shows as the accounts the response says it used.
  const [storedAccountIds, setAccountIds] = useLocalStorage<string[] | null>(SANKEY_STORAGE_KEYS.accounts, null);
  const accountIds = asAccountIds(storedAccountIds);
  const { dateRange, setDateRange, startDate, setStartDate, endDate, setEndDate, resolvedRange, isValid } =
    useDateRange({ defaultRange: 'mtd', storageKey: SANKEY_STORAGE_KEYS.range });
  const { start: rangeStart, end: rangeEnd } = resolvedRange;
  const requestedIds = accountIds ?? NO_IDS;
  const scopeKey = requestedIds.join(',');

  const { data: accounts } = useReportData(() => accountsApi.getAll(), []);
  const { data: categories } = useReportData(() => categoriesApi.getAll(), []);
  const { data: response, isLoading, error, reload } = useReportData(
    () =>
      isValid
        ? builtInReportsApi.getCashFlowSankey({
            startDate: rangeStart || undefined,
            endDate: rangeEnd,
            accountIds: requestedIds,
            depth,
          })
        : Promise.resolve(null),
    [isValid, rangeStart, rangeEnd, scopeKey, depth],
  );

  const { labelFor, colorOfNode } = useSankeyNodePresentation(categories);

  // The answer, once there is one to draw: nothing in the window is an empty
  // state, not an empty diagram. The previous answer is not this selection's
  // while the new request is pending or failed (the hook keeps it), so neither
  // the cards, the diagram nor an export read it then.
  const data = !isLoading && !error && response && response.nodes.length > 0 ? response : null;

  const reportingCurrency = response?.currency ?? defaultCurrency;

  const partOf = (total: number | null, known: number): ConvertedTotal =>
    total !== null
      ? { value: total, missingCurrencies: [], excludedCount: 0 }
      : {
          value: known,
          missingCurrencies: response?.missingCurrencies ?? [],
          excludedCount: response?.excludedCount ?? 0,
        };

  /** A figure, its known part marked partial, or "unknown" when nothing is known. */
  // Full precision wherever a figure is read against another (cards, table,
  // PDF); only the legend, which sits beside the drawing, is compact.
  const figure = (total: number | null, known: number | null) => {
    if (total !== null) return formatCurrency(total);
    if (known === null) return t('sankey.unknown');
    return (
      <PartialTotal total={partOf(total, known)} displayCurrency={reportingCurrency}>
        {formatCurrency(known)}
      </PartialTotal>
    );
  };

  const plain = (total: number | null) =>
    total === null ? t('sankey.unknown') : formatCurrency(total);

  // The residual card names whichever side the window landed on; an unknown
  // residual is captioned as the unspent one, with no figure.
  const residual =
    data && data.totals.deficit !== null && data.totals.deficit > 0
      ? { label: t('sankey.nodes.residualDeficit'), total: data.totals.deficit }
      : { label: t('sankey.nodes.residualUnspent'), total: data?.totals.unspent ?? null };

  // Every card reads the server's totals, never the drawing (SANKEY-005).
  const cards = data
    ? [
        { key: 'income', label: t('sankey.cardIncome'), total: data.totals.income, known: data.knownTotals.income },
        { key: 'inflows', label: t('sankey.cardInflows'), total: data.totals.inflows, known: data.knownTotals.inflows },
        { key: 'expenses', label: t('sankey.cardExpenses'), total: data.totals.expenses, known: data.knownTotals.expenses },
        { key: 'outflows', label: t('sankey.cardOutflows'), total: data.totals.outflows, known: data.knownTotals.outflows },
        { key: 'residual', label: residual.label, total: residual.total, known: null },
      ]
    : [];

  const ariaLabel = data
    ? t('sankey.ariaLabel', {
        income: plain(data.totals.income),
        inflows: plain(data.totals.inflows),
        expenses: plain(data.totals.expenses),
        outflows: plain(data.totals.outflows),
        residualLabel: residual.label,
        residual: plain(residual.total),
      })
    : '';

  // Every node but the hub, unmerged (SANKEY-005).
  const tableRows = useMemo(() => (data ? sankeyTableRows(data) : []), [data]);

  const sideLabel = (side: FlowSide, parent?: CashFlowSankeyNode) =>
    side === 'in'
      ? t('sankey.sideIn')
      : side === 'out'
        ? t('sankey.sideOut')
        : t('sankey.sideDetail', { parent: parent ? labelFor(parent) : '' });

  const open = (node: CashFlowSankeyNode) => {
    if (!data) return;
    const href = sankeyNodeHref(node, data);
    if (href) router.push(href);
  };

  const rangeLabel = response
    ? t('sankey.range', { start: formatDate(response.startDate), end: formatDate(response.endDate) })
    : '';

  const handleExportPdf = async () => {
    if (!data) return;
    const { exportToPdf } = await import('@/lib/pdf-export');
    await exportToPdf(withPdfBasis({
      title: t('sankey.pdfTitle'),
      subtitle: rangeLabel,
      summaryCards: cards.map((card) => ({
        label: card.label,
        value: card.total !== null ? formatCurrency(card.total) : card.known !== null ? `${formatCurrency(card.known)}*` : t('sankey.unknown'),
      })),
      chartContainer: view === 'sankey' ? chartRef.current : null,
      tableData: {
        headers: [t('sankey.colFlow'), t('sankey.colSide'), t('sankey.colAmount')],
        rows: tableRows.map((row) => [labelFor(row.node), sideLabel(row.side, row.parent), plain(row.node.total)]),
      },
      filename: 'cash-flow-sankey',
    }));
  };

  const handleExportCsv = () => {
    if (!data) return;
    const name = (id: string) => {
      const node = data.nodes.find((n) => n.id === id);
      return node ? labelFor(node) : id;
    };
    exportSectionsWithBasis('cash-flow-sankey', [
      {
        title: t('sankey.csvNodes'),
        headers: [
          t('sankey.colFlow'),
          t('sankey.colSide'),
          t('sankey.csvTotal'),
          t('sankey.csvKnownTotal'),
        ],
        rows: tableRows.map((row) => [labelFor(row.node), sideLabel(row.side, row.parent), row.node.total, row.node.knownTotal]),
      },
      {
        title: t('sankey.csvLinks'),
        headers: [
          t('sankey.csvSource'),
          t('sankey.csvTarget'),
          t('sankey.csvTotal'),
          t('sankey.csvKnownTotal'),
        ],
        rows: data.links.map((link) => [name(link.source), name(link.target), link.amount, link.knownAmount]),
      },
    ]);
  };

  const incomplete = data && (data.missingCurrencies.length > 0 || data.excludedCount > 0) ? data : null;

  return (
    <div className="space-y-6">
      {/* Controls stay mounted across a reload so a date being typed keeps focus. */}
      <Card className="p-4">
        <div className="flex flex-wrap gap-4 items-stretch justify-between">
          {/* Every control in this row takes the row's height, which is the
              account picker's: the presets through `fillRowHeight`, the
              segmented pills and the view toggle by stretching. */}
          <DateRangeSelector
            fillRowHeight
            ranges={['mtd', '1m', '3m', '6m', 'ytd', '1y']}
            value={dateRange}
            onChange={setDateRange}
            showCustom
            customStartDate={startDate}
            onCustomStartDateChange={setStartDate}
            customEndDate={endDate}
            onCustomEndDateChange={setEndDate}
          />
          <ReportAccountMultiSelect
            accounts={accounts ?? []}
            value={accountIds ?? response?.scopeAccountIds ?? NO_IDS}
            // Clearing every account asks for the default scope again, which
            // the picker then shows rather than an empty "all accounts".
            onChange={(ids) => setAccountIds(asAccountIds(ids))}
            className="w-full sm:w-56"
          />
          <div className={SEGMENTED_GROUP_CLASS} role="group" aria-label={t('sankey.depthLabel')}>
            <button type="button" aria-pressed={depth === 1} className={segmentClass(depth === 1)} onClick={() => setDepth(1)}>
              {t('sankey.depthCategories')}
            </button>
            <button type="button" aria-pressed={depth === 2} className={segmentClass(depth === 2)} onClick={() => setDepth(2)}>
              {t('sankey.depthSubcategories')}
            </button>
          </div>
          <ChartViewToggle
            value={view}
            onChange={(v) => setChosenView(v as SankeyView)}
            options={['sankey', 'table']}
          />
          <ReportToolbarActions onExportPdf={handleExportPdf} onExportCsv={handleExportCsv} disabled={!data} />
        </div>
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">{t('sankey.help')}</p>
      </Card>

      {data && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 sm:gap-4">
          {cards.map((card) => (
            <Card key={card.key} padding="sm" data-testid={`sankey-card-${card.key}`}>
              <div className="text-xs sm:text-sm text-gray-500 dark:text-gray-400">{card.label}</div>
              <div className="mt-1 text-lg sm:text-xl font-semibold text-gray-900 dark:text-gray-100">
                {figure(card.total, card.known)}
              </div>
            </Card>
          ))}
        </div>
      )}

      {incomplete && (
        <div className="space-y-2">
          {/* The banner names each pair and the window it was needed for; the
              count says how much of the ledger that cost. */}
          <IncompleteDataDetails
            causes={{
              prices: [],
              rates: incomplete.missingCurrencies.map((code) => ({
                key: `${code}->${incomplete.currency}`,
                start: incomplete.startDate,
                end: incomplete.endDate,
              })),
              cash: [],
            }}
            securityLabel={(id) => id}
            accountLabel={(id) => id}
          />
          <p className="text-sm text-amber-900 dark:text-amber-200" data-testid="sankey-excluded-count">
            {t('sankey.excludedCount', { count: incomplete.excludedCount })}
          </p>
        </div>
      )}

      <div ref={chartRef} className={`${CARD_CLASS} px-2 py-4 sm:p-6`}>
        {error ? (
          <ReportError onRetry={reload} />
        ) : isLoading ? (
          <div className="space-y-4">
            <Skeleton className="h-8 w-1/3" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : !data ? (
          <EmptyState
            title={t('sankey.noData')}
            description={rangeLabel || undefined}
          />
        ) : view === 'sankey' ? (
          <>
            <CashFlowSankeyDiagram
              data={data}
              categories={categories}
              ariaLabel={ariaLabel}
              onOpen={open}
              heightClass="h-[32rem]"
              // A phone has no room for desktop label gutters either side; the
              // dashboard widget's sizes are the ones that read on one.
              labelMargin={isMobile ? 96 : 160}
              fontSize={isMobile ? 11 : 12}
            />
            <ChartLegend
              className="mt-6"
              phoneColumns={2}
              columnsClassName="sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4"
              items={tableRows
                .filter((row) => row.side !== 'detail')
                .map((row) => ({
                  key: row.node.id,
                  name: labelFor(row.node),
                  color: colorOfNode(row.node),
                  detail: row.node.total === null ? t('sankey.unknown') : formatCurrencyCompact(row.node.total),
                  onClick: () => open(row.node),
                  disabled: sankeyNodeHref(row.node, data) === null,
                }))}
            />
          </>
        ) : (
          <div className="overflow-x-auto">
            {/* The table twin is the screen-reader rendering of the diagram,
                and the full answer: every node, unmerged. Explicit roles put
                back the semantics the phone layout's `display` strips. */}
            <table role="table" className={`${TABLE_CLASS} block sm:table`}>
              <thead role="rowgroup" className="hidden bg-gray-50 dark:bg-gray-900/50 sm:table-header-group">
                <tr role="row">
                  <th role="columnheader" className={`${HEADER_CLASS} text-left`}>{t('sankey.colFlow')}</th>
                  <th role="columnheader" className={`${HEADER_CLASS} text-left`}>{t('sankey.colSide')}</th>
                  <th role="columnheader" className={`${HEADER_CLASS} text-right`}>{t('sankey.colAmount')}</th>
                </tr>
              </thead>
              <tbody role="rowgroup" className={`${TABLE_BODY_CLASS} block sm:table-row-group`}>
                {tableRows.map(({ node, side, parent }) => {
                  const href = sankeyNodeHref(node, data);
                  return (
                    <tr
                      key={node.id}
                      role="row"
                      tabIndex={href ? 0 : undefined}
                      className={`${ROW_GRID} ${href ? `cursor-pointer ${INTERACTIVE_ROW_FOCUS_CLASS}` : ''} ${HOVER_ROW_ON_CARD} sm:table-row sm:p-0`}
                      onClick={href ? () => router.push(href) : undefined}
                      onKeyDown={href ? activateOnKey(() => router.push(href)) : undefined}
                      data-testid={`sankey-row-${node.id}`}
                    >
                      <td role="cell" className={`${IDENTITY_CELL} font-medium text-gray-900 dark:text-gray-100`}>
                        <div className={`flex items-center gap-2 ${side === 'detail' ? 'sm:pl-4' : ''}`}>
                          <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: colorOfNode(node) }} />
                          <span className="min-w-0 break-words sm:break-normal">{labelFor(node)}</span>
                        </div>
                      </td>
                      <td role="cell" className={SIDE_CELL}>
                        <CellLabel className={CAPTION_CLASS}>{t('sankey.colSide')}</CellLabel>
                        {sideLabel(side, parent)}
                      </td>
                      <td role="cell" className={`${FIGURE_CELL} text-gray-900 dark:text-gray-100`}>
                        <CellLabel className={CAPTION_CLASS}>{t('sankey.colAmount')}</CellLabel>
                        {figure(node.total, node.kind === 'residual' ? null : node.knownTotal)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
