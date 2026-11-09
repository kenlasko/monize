'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  PieChart,
  Pie,
  Cell,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { Account } from '@/types/account';
import { HoldingWithMarketValue, Security } from '@/types/investment';
import { investmentsApi } from '@/lib/investments';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useReportData } from '@/hooks/useReportData';
import { useWidgetConfig } from '@/hooks/useWidgetConfig';
import { chartSeriesColor } from '@/lib/chart-colors';
import { computeGeographicAllocation } from '@/lib/geographic-allocation';
import { ChartTooltipPanel } from '@/components/reports/ChartTooltip';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { WeightingPartialNote } from '@/components/reports/WeightingPartialNote';
import { WidgetCard, WidgetConfigRow, WidgetMessage } from './WidgetCard';
import { WidgetSegmentedControl } from './WidgetSegmentedControl';
import { GEOGRAPHIC_ALLOCATION_DEFAULT, GeographicConfig } from './widget-config';
import { CHART_GRID_PROPS_HORIZONTAL_BARS } from '@/lib/chart-style';

const WIDGET_ID = 'geographic-allocation';
const MAX_EXCHANGE_BARS = 8;

interface GeographicAllocationWidgetProps {
  accounts: Account[];
  isLoading: boolean;
}

interface SimpleSlice {
  name: string;
  value: number;
  percentage: number;
  color: string;
}

export function GeographicAllocationWidget({
  accounts,
  isLoading,
}: GeographicAllocationWidgetProps) {
  const t = useTranslations('dashboard');
  const tCommon = useTranslations('common');
  const { formatCurrency, formatCurrencyAxis, formatPercent } = useNumberFormat();
  const { convertToDefault, defaultCurrency } = useExchangeRates();
  const { config, updateConfig } = useWidgetConfig<GeographicConfig>(
    WIDGET_ID,
    GEOGRAPHIC_ALLOCATION_DEFAULT,
  );

  const investmentAccounts = useMemo(
    () => accounts.filter((a) => a.accountType === 'INVESTMENT'),
    [accounts],
  );

  const accountIds = config.accountIds.length > 0 ? config.accountIds : undefined;

  const { data: summary, isLoading: summaryLoading } = useReportData(
    () => investmentsApi.getPortfolioValuation(accountIds),
    [config.accountIds],
  );

  const { data: securities } = useReportData(
    () => investmentsApi.getSecurities(),
    [],
  );

  const { data: countryResp, isLoading: countryLoading } = useReportData(
    () => investmentsApi.getCountryWeightings(accountIds),
    [config.accountIds],
  );

  const holdings = useMemo<HoldingWithMarketValue[]>(
    () => summary?.holdings ?? [],
    [summary],
  );

  const securityExchangeMap = useMemo(() => {
    const map = new Map<string, string>();
    (securities ?? []).forEach((s: Security) => {
      if (s.exchange) map.set(s.id, s.exchange);
    });
    return map;
  }, [securities]);

  const { exchangeData, regionData, missingCurrencies, excludedCount } = useMemo(
    () => computeGeographicAllocation(holdings, securityExchangeMap, convertToDefault),
    [holdings, securityExchangeMap, convertToDefault],
  );

  const regionSlices = useMemo<SimpleSlice[]>(
    () =>
      regionData.map((r) => ({
        name: r.region,
        value: r.marketValue,
        percentage: r.percentage,
        color: r.color,
      })),
    [regionData],
  );

  const exchangeBars = useMemo(
    () => exchangeData.slice(0, MAX_EXCHANGE_BARS),
    [exchangeData],
  );

  const countrySlices = useMemo<SimpleSlice[]>(
    () =>
      (countryResp?.items ?? []).map((item, idx) => ({
        name: item.country,
        value: item.totalValue,
        percentage: item.percentage,
        color: chartSeriesColor(idx),
      })),
    [countryResp],
  );

  const configControls = (
    <>
      <WidgetConfigRow label={t('widgets.accounts')}>
        <ReportAccountMultiSelect
          accounts={investmentAccounts}
          value={config.accountIds}
          onChange={(ids) => updateConfig({ accountIds: ids })}
          mode="portfolio"
          className="w-full"
        />
      </WidgetConfigRow>
      <WidgetConfigRow label={t('widgets.view')}>
        <WidgetSegmentedControl
          value={config.view}
          onChange={(view) => updateConfig({ view })}
          options={[
            { value: 'region', label: t('geographicAllocation.viewRegion') },
            { value: 'exchange', label: t('geographicAllocation.viewExchange') },
            { value: 'country', label: t('geographicAllocation.viewCountry') },
          ]}
        />
      </WidgetConfigRow>
    </>
  );

  const loading =
    isLoading ||
    (config.view === 'country' ? countryLoading : summaryLoading);

  const activeSlices = config.view === 'country' ? countrySlices : regionSlices;
  const isEmpty =
    config.view === 'exchange' ? exchangeBars.length === 0 : activeSlices.length === 0;

  // Region and exchange shares are computed from the holdings converted into the
  // display currency; the country view comes from a separate backend endpoint,
  // so its slices are not touched by the FX exclusions tracked here. Only mark
  // the two client-computed views, and only when a holding was actually dropped
  // -- otherwise the percentage bars read as 100% of the portfolio when they are
  // a subtotal of the convertible part.
  const showPartial = config.view !== 'country' && excludedCount > 0;
  const partialNote = showPartial
    ? missingCurrencies.length > 0
      ? tCommon('partialTotal.explanation', {
          count: excludedCount,
          displayCurrency: defaultCurrency,
          currencies: missingCurrencies.join(', '),
        })
      : tCommon('partialTotal.explanationExcluded', { count: excludedCount })
    : null;

  const sliceTooltip = (active: boolean | undefined, rawPayload: unknown) => {
    const payload = rawPayload as Array<{ payload: SimpleSlice }> | undefined;
    if (!active || !payload?.length) return null;
    const d = payload[0].payload;
    return (
      <ChartTooltipPanel>
        <p className="font-medium text-gray-900 dark:text-gray-100">{d.name}</p>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {formatCurrency(d.value)} ({formatPercent(d.percentage, 1)})
        </p>
      </ChartTooltipPanel>
    );
  };

  return (
    <WidgetCard
      title={t('geographicAllocation.title')}
      titleHref="/investments"
      widgetId={WIDGET_ID}
      configControls={configControls}
      configTitle={t('geographicAllocation.title')}
    >
      {loading ? (
        <div className="flex-1 min-h-[260px] animate-pulse skeleton-shimmer rounded-md bg-gray-100 dark:bg-gray-700/50" />
      ) : isEmpty ? (
        // Nothing to draw: either there are no holdings, or every one was
        // dropped for want of a price or rate. Say which so an all-excluded
        // portfolio is not shown as an ordinary empty state.
        <WidgetMessage>{partialNote ?? t('geographicAllocation.empty')}</WidgetMessage>
      ) : config.view === 'exchange' ? (
        <div className="flex-1 min-h-[260px]">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <BarChart data={exchangeBars} layout="vertical" margin={{ left: 8, right: 16 }}>
              <CartesianGrid {...CHART_GRID_PROPS_HORIZONTAL_BARS} />
              <XAxis type="number" tickFormatter={formatCurrencyAxis} tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="exchange" width={80} tick={{ fontSize: 11 }} />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0].payload as (typeof exchangeBars)[number];
                  return (
                    <ChartTooltipPanel>
                      <p className="font-medium text-gray-900 dark:text-gray-100">{d.exchange}</p>
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        {formatCurrency(d.marketValue)} ({formatPercent(d.percentage, 1)})
                      </p>
                    </ChartTooltipPanel>
                  );
                }}
              />
              <Bar dataKey="marketValue" radius={[0, 4, 4, 0]}>
                {exchangeBars.map((entry, index) => (
                  <Cell key={entry.exchange} fill={chartSeriesColor(index)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      ) : (
        <>
          <div className="flex-1 min-h-[220px]">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <PieChart>
                <Pie
                  data={activeSlices}
                  cx="50%"
                  cy="50%"
                  innerRadius="55%"
                  outerRadius="85%"
                  paddingAngle={2}
                  dataKey="value"
                  nameKey="name"
                >
                  {activeSlices.map((entry) => (
                    <Cell key={entry.name} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip content={({ active, payload }) => sliceTooltip(active, payload)} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm flex-shrink-0">
            {activeSlices.slice(0, 6).map((entry) => (
              <div key={entry.name} className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: entry.color }} />
                <span className="text-gray-500 dark:text-gray-400 truncate">{entry.name}</span>
                <span className="ml-auto text-gray-900 dark:text-gray-100">
                  {formatPercent(entry.percentage, 0)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
      {!loading && !isEmpty && config.view !== 'country' && (
        // Region and exchange both classify a holding by where it is listed, so
        // a globally diversified fund bought on the NYSE counts as North
        // America. Say so, and name the view that looks inside it, rather than
        // leaving the chart to be read as economic exposure.
        <p className="mt-2 text-xs text-gray-500 dark:text-gray-400">
          {t('geographicAllocation.listingBasisNote')}
        </p>
      )}
      {!loading && !isEmpty && config.view === 'country' && <WeightingPartialNote result={countryResp} />}
      {!loading && !isEmpty && partialNote && (
        // Some holdings converted and some did not: the shares above are of the
        // convertible subset, so mark them a subtotal rather than 100%.
        <p className="mt-2 text-xs text-amber-600 dark:text-amber-400" data-testid="partial-note">{partialNote}</p>
      )}
    </WidgetCard>
  );
}
