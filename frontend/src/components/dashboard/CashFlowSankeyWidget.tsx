'use client';

import { CashReportingNotice } from '@/components/reports/ReportingBasis';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Account } from '@/types/account';
import type { CashFlowSankeyNode } from '@/types/built-in-reports';
import { builtInReportsApi } from '@/lib/built-in-reports';
import { categoriesApi } from '@/lib/categories';
import { resolveRangePreset } from '@/lib/date-range';
import type { ConvertedTotal } from '@/lib/currency-total';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useReportData } from '@/hooks/useReportData';
import { useWidgetConfig } from '@/hooks/useWidgetConfig';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import {
  CashFlowSankeyDiagram,
  sankeyNodeHref,
  sankeyTableRows,
  useSankeyNodePresentation,
} from '@/components/reports/CashFlowSankeyDiagram';
import { WidgetCard, WidgetConfigRow, WidgetMessage } from './WidgetCard';
import { WidgetSegmentedControl } from './WidgetSegmentedControl';
import {
  CASH_FLOW_SANKEY_DEFAULT,
  SPENDING_RANGES,
  CashFlowSankeyConfig,
} from './widget-config';

const WIDGET_ID = 'cash-flow-sankey';

interface CashFlowSankeyWidgetProps {
  accounts: Account[];
  isLoading: boolean;
}

/**
 * The Cash Flow Sankey on the dashboard, with the report's settings: the
 * window, the account scope, the depth and the view. Every figure is the
 * report endpoint's, drawn by the report's own diagram, so the widget and the
 * report cannot disagree about the same window.
 */
export function CashFlowSankeyWidget({ accounts, isLoading }: CashFlowSankeyWidgetProps) {
  const t = useTranslations('dashboard');
  const tr = useTranslations('reports');
  const router = useRouter();
  const { formatCurrencyCompact } = useNumberFormat();
  const { config, updateConfig } = useWidgetConfig<CashFlowSankeyConfig>(
    WIDGET_ID,
    CASH_FLOW_SANKEY_DEFAULT,
  );
  // Stored settings are whatever the preference row holds; read each through
  // its shape so a stale value cannot reach the request.
  const depth = config.depth === 2 ? 2 : 1;
  const view = config.view === 'table' ? 'table' : 'sankey';
  const accountIds = Array.isArray(config.accountIds) ? config.accountIds : [];
  const accountIdsKey = accountIds.join(',');

  const { start, end } = useMemo(() => resolveRangePreset(config.range), [config.range]);

  const { data: categories } = useReportData(() => categoriesApi.getAll(), []);
  const { data: response, isLoading: dataLoading } = useReportData(
    () =>
      builtInReportsApi.getCashFlowSankey({
        startDate: start || undefined,
        endDate: end,
        accountIds,
        depth,
      }),
    [start, end, accountIdsKey, depth],
  );
  const data = response && response.nodes.length > 0 ? response : null;
  const { labelFor, colorOfNode } = useSankeyNodePresentation(categories);

  const plain = (total: number | null) =>
    total === null ? tr('sankey.unknown') : formatCurrencyCompact(total);

  const residual =
    data && data.totals.deficit !== null && data.totals.deficit > 0
      ? { label: tr('sankey.nodes.residualDeficit'), total: data.totals.deficit }
      : { label: tr('sankey.nodes.residualUnspent'), total: data?.totals.unspent ?? null };

  const ariaLabel = data
    ? tr('sankey.ariaLabel', {
        income: plain(data.totals.income),
        inflows: plain(data.totals.inflows),
        expenses: plain(data.totals.expenses),
        outflows: plain(data.totals.outflows),
        residualLabel: residual.label,
        residual: plain(residual.total),
      })
    : '';

  const partial = (known: number): ConvertedTotal => ({
    value: known,
    missingCurrencies: data?.missingCurrencies ?? [],
    excludedCount: data?.excludedCount ?? 0,
  });

  const figure = (node: CashFlowSankeyNode) => {
    if (node.total !== null) return formatCurrencyCompact(node.total);
    if (node.kind === 'residual') return tr('sankey.unknown');
    return (
      <PartialTotal total={partial(node.knownTotal)} displayCurrency={data?.currency ?? ''}>
        {formatCurrencyCompact(node.knownTotal)}
      </PartialTotal>
    );
  };

  const open = (node: CashFlowSankeyNode) => {
    if (!data) return;
    const href = sankeyNodeHref(node, data);
    if (href) router.push(href);
  };

  const configControls = (
    <>
      <WidgetConfigRow label={t('widgets.timeframe')}>
        <DateRangeSelector
          ranges={SPENDING_RANGES}
          value={config.range}
          onChange={(range) => updateConfig({ range })}
          size="sm"
        />
      </WidgetConfigRow>
      <WidgetConfigRow label={t('widgets.accounts')}>
        <ReportAccountMultiSelect
          accounts={accounts}
          // Empty is the server's default scope; show which accounts that was.
          value={accountIds.length > 0 ? accountIds : (response?.scopeAccountIds ?? [])}
          onChange={(ids) => updateConfig({ accountIds: ids })}
          className="w-full"
        />
      </WidgetConfigRow>
      <WidgetConfigRow label={t('cashFlowSankey.depth')}>
        <WidgetSegmentedControl
          value={depth === 2 ? 'subcategories' : 'categories'}
          onChange={(value) => updateConfig({ depth: value === 'subcategories' ? 2 : 1 })}
          options={[
            { value: 'categories', label: t('cashFlowSankey.depthCategories') },
            { value: 'subcategories', label: t('cashFlowSankey.depthSubcategories') },
          ]}
        />
      </WidgetConfigRow>
      <WidgetConfigRow label={t('widgets.view')}>
        <WidgetSegmentedControl
          value={view}
          onChange={(value) => updateConfig({ view: value })}
          options={[
            { value: 'sankey', label: t('cashFlowSankey.viewDiagram') },
            { value: 'table', label: t('cashFlowSankey.viewTable') },
          ]}
        />
      </WidgetConfigRow>
    </>
  );

  const loading = isLoading || dataLoading;
  const incomplete = !!data && (data.missingCurrencies.length > 0 || data.excludedCount > 0);

  return (
    <WidgetCard
      title={t('cashFlowSankey.title')}
      titleHref="/reports/cash-flow-sankey"
      widgetId={WIDGET_ID}
      headerRight={
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {t(`widgets.rangeLabels.${config.range}` as Parameters<typeof t>[0])}
        </span>
      }
      configControls={configControls}
      configTitle={t('cashFlowSankey.title')}
    >
      <CashReportingNotice />
      {loading ? (
        <div className="flex-1 min-h-[300px] animate-pulse rounded-md bg-gray-100 dark:bg-gray-700/50" />
      ) : !data ? (
        <WidgetMessage>{t('cashFlowSankey.empty')}</WidgetMessage>
      ) : (
        <>
          {view === 'sankey' ? (
            <CashFlowSankeyDiagram
              data={data}
              categories={categories}
              ariaLabel={ariaLabel}
              onOpen={open}
              heightClass="flex-1 min-h-[300px]"
              labelMargin={96}
              fontSize={11}
            />
          ) : (
            // Every node, unmerged, from the response (SANKEY-005).
            <ul className="flex-1 divide-y divide-gray-100 dark:divide-gray-700 text-sm" data-testid="cash-flow-sankey-widget-table">
              {sankeyTableRows(data).map(({ node, side }) => (
                <li key={node.id} className={`flex items-center gap-2 py-1.5 ${side === 'detail' ? 'pl-4' : ''}`}>
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: colorOfNode(node) }} />
                  <span className="min-w-0 truncate text-gray-700 dark:text-gray-300">{labelFor(node)}</span>
                  <span className="ml-auto whitespace-nowrap font-medium text-gray-900 dark:text-gray-100">
                    {figure(node)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex items-center justify-between text-sm flex-shrink-0">
            <span className="text-gray-500 dark:text-gray-400">{residual.label}</span>
            <span className="font-medium text-gray-900 dark:text-gray-100">{plain(residual.total)}</span>
          </div>
          {incomplete && (
            <p className="mt-1 text-xs text-amber-700 dark:text-amber-300" data-testid="cash-flow-sankey-widget-incomplete">
              {tr('sankey.excludedCount', { count: data.excludedCount })}
            </p>
          )}
        </>
      )}
    </WidgetCard>
  );
}
