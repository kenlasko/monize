'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { Account } from '@/types/account';
import { HoldingWithMarketValue } from '@/types/investment';
import { investmentsApi } from '@/lib/investments';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useReportData } from '@/hooks/useReportData';
import { useWidgetConfig } from '@/hooks/useWidgetConfig';
import { chartColors, CHART_SERIES, chartSeriesColor } from '@/lib/chart-colors';
import { aggregateHoldingsBySecurity } from '@/lib/aggregate-holdings';
import { ChartTooltipPanel } from '@/components/reports/ChartTooltip';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { WidgetCard, WidgetConfigRow, WidgetMessage } from './WidgetCard';
import { SECURITY_TYPE_ALLOCATION_DEFAULT, AccountsConfig } from './widget-config';

const WIDGET_ID = 'security-type-allocation';

const excludeCashAccounts = (a: Account) => a.accountSubType !== 'INVESTMENT_CASH';

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
  const { formatCurrency } = useNumberFormat();
  const { convertToDefault } = useExchangeRates();
  const { config, updateConfig } = useWidgetConfig<AccountsConfig>(
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

  const allocationData = useMemo<TypeAllocation[]>(() => {
    const aggregated = aggregateHoldingsBySecurity(holdings);
    const typeMap = new Map<string, number>();
    aggregated.forEach((h) => {
      const type = h.securityType || 'OTHER';
      const converted = convertToDefault(h.marketValue ?? 0, h.currencyCode);
      typeMap.set(type, (typeMap.get(type) ?? 0) + converted);
    });

    const totalValue = Array.from(typeMap.values()).reduce((sum, v) => sum + v, 0);
    let colorIndex = 0;

    return Array.from(typeMap.entries())
      .map(([type, value]) => ({
        type,
        label: typeLabel(type),
        totalValue: value,
        percentage: totalValue > 0 ? (value / totalValue) * 100 : 0,
        color: TYPE_COLOURS[type] || chartSeriesColor(colorIndex++),
      }))
      .sort((a, b) => b.totalValue - a.totalValue);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holdings, convertToDefault, t]);

  const configControls = (
    <WidgetConfigRow label={t('widgets.accounts')}>
      <ReportAccountMultiSelect
        accounts={investmentAccounts}
        value={config.accountIds}
        onChange={(accountIds) => updateConfig({ accountIds })}
        filter={excludeCashAccounts}
        className="w-full"
      />
    </WidgetConfigRow>
  );

  const loading = isLoading || dataLoading;

  return (
    <WidgetCard
      title={t('securityTypeAllocation.title')}
      widgetId={WIDGET_ID}
      configControls={configControls}
      configTitle={t('securityTypeAllocation.title')}
    >
      {loading ? (
        <div className="flex-1 min-h-[260px] animate-pulse rounded-md bg-gray-100 dark:bg-gray-700/50" />
      ) : allocationData.length === 0 ? (
        <WidgetMessage>{t('securityTypeAllocation.empty')}</WidgetMessage>
      ) : (
        <>
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
                          {formatCurrency(d.totalValue)} ({d.percentage.toFixed(1)}%)
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
                  {entry.percentage.toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </WidgetCard>
  );
}
