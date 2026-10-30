'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { Account } from '@/types/account';
import { HoldingWithMarketValue, WeightingCompleteness } from '@/types/investment';
import { investmentsApi } from '@/lib/investments';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useReportData } from '@/hooks/useReportData';
import { useWidgetConfig } from '@/hooks/useWidgetConfig';
import { useAssetClassLabel } from '@/hooks/useAssetClassLabel';
import { chartColors, CHART_SERIES, chartSeriesColor } from '@/lib/chart-colors';
import { aggregateHoldingsBySecurity } from '@/lib/aggregate-holdings';
import { ChartTooltipPanel } from '@/components/reports/ChartTooltip';
import { collapseLookThrough } from '@/lib/look-through-allocation';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { WeightingPartialNote } from '@/components/reports/WeightingPartialNote';
import { WidgetCard, WidgetConfigRow, WidgetMessage } from './WidgetCard';
import { WidgetSegmentedControl } from './WidgetSegmentedControl';
import {
  SECURITY_TYPE_ALLOCATION_DEFAULT,
  SecurityTypeAllocationConfig,
} from './widget-config';

const WIDGET_ID = 'security-type-allocation';

const TYPE_COLOURS: Record<string, string> = {
  STOCK: CHART_SERIES[0],
  ETF: CHART_SERIES[1],
  MUTUAL_FUND: CHART_SERIES[8],
  BOND: CHART_SERIES[4],
  CASH: chartColors.axis,
};

interface SecurityTypeAllocationWidgetProps {
  accounts: Account[];
  isLoading: boolean;
}

interface TypeAllocation {
  type: string;
  label: string;
  totalValue: number;
  percentage: number;
  color: string;
}

export function SecurityTypeAllocationWidget({
  accounts,
  isLoading,
}: SecurityTypeAllocationWidgetProps) {
  const t = useTranslations('dashboard');
  const assetClassLabel = useAssetClassLabel();
  const { formatCurrency, formatPercent } = useNumberFormat();
  const { convertToDefault, defaultCurrency } = useExchangeRates();
  const { config, updateConfig } = useWidgetConfig<SecurityTypeAllocationConfig>(
    WIDGET_ID,
    SECURITY_TYPE_ALLOCATION_DEFAULT,
  );

  const investmentAccounts = useMemo(
    () => accounts.filter((a) => a.accountType === 'INVESTMENT'),
    [accounts],
  );

  const typeLabel = (type: string): string => {
    const known = ['STOCK', 'ETF', 'MUTUAL_FUND', 'BOND', 'CASH'];
    return known.includes(type)
      ? t(`securityTypeAllocation.types.${type}` as Parameters<typeof t>[0])
      : type;
  };

  const { data: summary, isLoading: dataLoading } = useReportData(
    () =>
      investmentsApi.getPortfolioSummary(
        config.accountIds.length > 0 ? config.accountIds : undefined,
      ),
    [config.accountIds],
  );

  const holdings = useMemo<HoldingWithMarketValue[]>(
    () => summary?.holdings ?? [],
    [summary],
  );

  // The look-through breakdown, which sees inside a fund rather than filing all
  // of it under ETF. Fetched only while that view is active, so the ordinary
  // security-type view costs no extra request.
  const { data: assetClasses, isLoading: assetClassLoading } = useReportData(
    () =>
      config.view === 'assetClass'
        ? investmentsApi.getAssetClassWeightings(
            config.accountIds.length > 0 ? config.accountIds : undefined,
          )
        : Promise.resolve(null),
    [config.accountIds, config.view],
  );

  const assetClassData = useMemo<TypeAllocation[]>(() => {
    if (!assetClasses) return [];
    return collapseLookThrough(
      {
        items: assetClasses.items.map((item) => ({
          name: assetClassLabel(item),
          totalValue: item.totalValue,
          percentage: item.percentage,
        })),
        totalPortfolioValue: assetClasses.totalPortfolioValue,
        unclassifiedValue: assetClasses.unclassifiedValue,
      },
      t('securityTypeAllocation.otherAssetClasses'),
    ).map((slice, index) => ({
      type: slice.name,
      label: slice.name,
      totalValue: slice.value,
      percentage: slice.percentage,
      color: slice.isOther ? chartColors.axis : chartSeriesColor(index),
    }));
  }, [assetClasses, assetClassLabel, t]);

  const { typeData, typeCompleteness } = useMemo(() => {
    const aggregated = aggregateHoldingsBySecurity(holdings);
    const typeMap = new Map<string, number>();
    const unpricedSymbols: string[] = [];
    const missingRatePairs: string[] = [];
    aggregated.forEach((h) => {
      const type = h.securityType || 'OTHER';
      // An unpriced holding has no market value and a missing rate has no
      // conversion. Either way this holding cannot be placed on the chart --
      // `?? 0` used to fold it in as a zero-size slice of a smaller total, which
      // silently changed every other slice's percentage.
      // It is reported through `WeightingPartialNote` instead of dropped silently.
      if (h.marketValue === null || h.marketValue === undefined) {
        unpricedSymbols.push(h.symbol);
        return;
      }
      const converted = convertToDefault(h.marketValue, h.currencyCode);
      if (converted === null) {
        const pair = `${h.currencyCode}->${defaultCurrency}`;
        if (!missingRatePairs.includes(pair)) missingRatePairs.push(pair);
        return;
      }
      typeMap.set(type, (typeMap.get(type) ?? 0) + converted);
    });

    const totalValue = Array.from(typeMap.values()).reduce((sum, v) => sum + v, 0);
    let colorIndex = 0;

    const typeData: TypeAllocation[] = Array.from(typeMap.entries())
      .map(([type, value]) => ({
        type,
        label: typeLabel(type),
        totalValue: value,
        percentage: totalValue > 0 ? (value / totalValue) * 100 : 0,
        color: TYPE_COLOURS[type] || chartSeriesColor(colorIndex++),
      }))
      .sort((a, b) => b.totalValue - a.totalValue);
    const typeCompleteness: WeightingCompleteness = {
      valuationComplete: unpricedSymbols.length === 0 && missingRatePairs.length === 0,
      unpricedSymbols,
      missingRatePairs,
    };
    return { typeData, typeCompleteness };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holdings, convertToDefault, defaultCurrency, t]);

  const allocationData = config.view === 'assetClass' ? assetClassData : typeData;

  const configControls = (
    <>
      <WidgetConfigRow label={t('widgets.accounts')}>
        <ReportAccountMultiSelect
          accounts={investmentAccounts}
          value={config.accountIds}
          onChange={(accountIds) => updateConfig({ accountIds })}
          mode="portfolio"
          className="w-full"
        />
      </WidgetConfigRow>
      <WidgetConfigRow label={t('widgets.view')}>
        <WidgetSegmentedControl
          value={config.view}
          onChange={(view) => updateConfig({ view })}
          options={[
            { value: 'type', label: t('securityTypeAllocation.viewType') },
            { value: 'assetClass', label: t('securityTypeAllocation.viewAssetClass') },
          ]}
        />
      </WidgetConfigRow>
    </>
  );

  const loading =
    isLoading || (config.view === 'assetClass' ? assetClassLoading : dataLoading);

  return (
    <WidgetCard
      title={t('securityTypeAllocation.title')}
      titleHref="/investments"
      widgetId={WIDGET_ID}
      configControls={configControls}
      configTitle={t('securityTypeAllocation.title')}
    >
      {loading ? (
        <div className="flex-1 min-h-[260px] animate-pulse rounded-md bg-gray-100 dark:bg-gray-700/50" />
      ) : allocationData.length === 0 ? (
        <WidgetMessage>
          {config.view === 'assetClass'
            ? t('securityTypeAllocation.emptyAssetClass')
            : t('securityTypeAllocation.empty')}
        </WidgetMessage>
      ) : (
        <>
          <WeightingPartialNote result={config.view === 'assetClass' ? assetClasses : typeCompleteness} />
          <div className="flex-1 min-h-[240px]">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <PieChart>
                <Pie
                  data={allocationData}
                  cx="50%"
                  cy="50%"
                  innerRadius="55%"
                  outerRadius="85%"
                  paddingAngle={2}
                  dataKey="totalValue"
                  nameKey="label"
                >
                  {allocationData.map((entry) => (
                    <Cell key={entry.type} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const d = payload[0].payload as TypeAllocation;
                    return (
                      <ChartTooltipPanel>
                        <p className="font-medium text-gray-900 dark:text-gray-100">{d.label}</p>
                        <p className="text-sm text-gray-600 dark:text-gray-400">
                          {formatCurrency(d.totalValue)} ({formatPercent(d.percentage, 1)})
                        </p>
                      </ChartTooltipPanel>
                    );
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm flex-shrink-0">
            {allocationData.map((entry) => (
              <div key={entry.type} className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: entry.color }} />
                <span className="text-gray-500 dark:text-gray-400 truncate">{entry.label}</span>
                <span className="ml-auto text-gray-900 dark:text-gray-100">
                  {formatPercent(entry.percentage, 0)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </WidgetCard>
  );
}
