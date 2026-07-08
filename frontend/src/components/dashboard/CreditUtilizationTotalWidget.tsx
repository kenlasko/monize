'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer } from 'recharts';
import { Account } from '@/types/account';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useWidgetConfig } from '@/hooks/useWidgetConfig';
import { chartColors } from '@/lib/chart-colors';
import {
  isCreditAccount,
  utilizationColour,
  computeCreditRows,
  computeCreditTotals,
} from '@/lib/credit-utilization';
import { ChartTooltipPanel } from '@/components/reports/ChartTooltip';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { WidgetCard, WidgetConfigRow, WidgetMessage } from './WidgetCard';
import { CREDIT_UTILIZATION_TOTAL_DEFAULT, AccountsConfig } from './widget-config';

const WIDGET_ID = 'credit-utilization-total';

interface CreditUtilizationTotalWidgetProps {
  accounts: Account[];
  isLoading: boolean;
}

interface TotalSlice {
  key: 'used' | 'available';
  name: string;
  value: number;
  percent: number;
  color: string;
}

export function CreditUtilizationTotalWidget({
  accounts,
  isLoading,
}: CreditUtilizationTotalWidgetProps) {
  const t = useTranslations('dashboard');
  const { formatCurrency } = useNumberFormat();
  const { convert, defaultCurrency } = useExchangeRates();
  const { config, updateConfig } = useWidgetConfig<AccountsConfig>(
    WIDGET_ID,
    CREDIT_UTILIZATION_TOTAL_DEFAULT,
  );

  const creditAccounts = useMemo(() => accounts.filter(isCreditAccount), [accounts]);

  const activeAccounts = useMemo(
    () =>
      config.accountIds.length > 0
        ? creditAccounts.filter((a) => config.accountIds.includes(a.id))
        : creditAccounts,
    [creditAccounts, config.accountIds],
  );

  const displayCurrency = useMemo(() => {
    const currencies = new Set(activeAccounts.map((a) => a.currencyCode));
    return currencies.size === 1 ? [...currencies][0] : defaultCurrency;
  }, [activeAccounts, defaultCurrency]);

  const totals = useMemo(
    () => computeCreditTotals(computeCreditRows(activeAccounts, convert, displayCurrency)),
    [activeAccounts, convert, displayCurrency],
  );

  const availableForPie = Math.max(totals.available, 0);
  const pieData: TotalSlice[] = [
    {
      key: 'used',
      name: t('creditUtilizationTotal.used'),
      value: totals.used,
      percent: totals.utilizationPercent,
      color: utilizationColour(totals.utilizationPercent),
    },
    {
      key: 'available',
      name: t('creditUtilizationTotal.available'),
      value: availableForPie,
      percent: totals.limit > 0 ? (availableForPie / totals.limit) * 100 : 0,
      color: chartColors.grid,
    },
  ];

  const configControls = (
    <WidgetConfigRow label={t('widgets.accounts')}>
      <ReportAccountMultiSelect
        accounts={creditAccounts}
        value={config.accountIds}
        onChange={(accountIds) => updateConfig({ accountIds })}
        filter={() => true}
        className="w-full"
      />
    </WidgetConfigRow>
  );

  return (
    <WidgetCard
      title={t('creditUtilizationTotal.title')}
      widgetId={WIDGET_ID}
      configControls={creditAccounts.length > 0 ? configControls : undefined}
      configTitle={t('creditUtilizationTotal.title')}
    >
      {isLoading ? (
        <div className="flex-1 min-h-[260px] animate-pulse rounded-md bg-gray-100 dark:bg-gray-700/50" />
      ) : totals.limit === 0 ? (
        <WidgetMessage>{t('creditUtilizationTotal.empty')}</WidgetMessage>
      ) : (
        <>
          <div className="flex-1 min-h-[220px] relative">
            <ResponsiveContainer width="100%" height="100%" minWidth={0}>
              <PieChart>
                <Pie
                  data={pieData}
                  cx="50%"
                  cy="50%"
                  innerRadius="62%"
                  outerRadius="90%"
                  startAngle={90}
                  endAngle={-270}
                  paddingAngle={2}
                  dataKey="value"
                >
                  {pieData.map((slice) => (
                    <Cell key={slice.key} fill={slice.color} />
                  ))}
                </Pie>
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload?.length) return null;
                    const slice = payload[0].payload as TotalSlice;
                    return (
                      <ChartTooltipPanel>
                        <p className="font-medium text-gray-900 dark:text-gray-100">{slice.name}</p>
                        <p className="text-sm text-gray-600 dark:text-gray-400">
                          {formatCurrency(slice.value, displayCurrency)} ({slice.percent.toFixed(1)}%)
                        </p>
                      </ChartTooltipPanel>
                    );
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <span className="text-2xl font-bold text-gray-900 dark:text-gray-100">
                {totals.utilizationPercent.toFixed(1)}%
              </span>
            </div>
          </div>
          <div className="mt-3 space-y-1.5 text-sm flex-shrink-0">
            {pieData.map((slice) => (
              <div key={slice.key} className="flex items-center gap-2">
                <span className="w-3 h-3 rounded-sm shrink-0" style={{ backgroundColor: slice.color }} />
                <span className="flex-1 text-gray-500 dark:text-gray-400">{slice.name}</span>
                <span className="font-medium text-gray-900 dark:text-gray-100">
                  {formatCurrency(slice.value, displayCurrency)}
                </span>
              </div>
            ))}
          </div>
        </>
      )}
    </WidgetCard>
  );
}
