'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { Account } from '@/types/account';
import { investmentsApi } from '@/lib/investments';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useReportData } from '@/hooks/useReportData';
import { useWidgetConfig } from '@/hooks/useWidgetConfig';
import { chartColors } from '@/lib/chart-colors';
import { ChartTooltipPanel } from '@/components/reports/ChartTooltip';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { WidgetCard, WidgetConfigRow, WidgetMessage } from './WidgetCard';
import { SECTOR_WEIGHTINGS_DEFAULT, AccountsConfig } from './widget-config';

const WIDGET_ID = 'sector-weightings';

// Holdings are keyed off the brokerage sub-account; the sibling cash account is
// excluded from the picker.
const excludeCashAccounts = (a: Account) => a.accountSubType !== 'INVESTMENT_CASH';

interface SectorWeightingsWidgetProps {
  accounts: Account[];
  isLoading: boolean;
}

export function SectorWeightingsWidget({ accounts, isLoading }: SectorWeightingsWidgetProps) {
  const t = useTranslations('dashboard');
  const { formatCurrency, formatCurrencyAxis } = useNumberFormat();
  const { defaultCurrency } = useExchangeRates();
  const { config, updateConfig } = useWidgetConfig<AccountsConfig>(
    WIDGET_ID,
    SECTOR_WEIGHTINGS_DEFAULT,
  );

  const investmentAccounts = useMemo(
    () => accounts.filter((a) => a.accountType === 'INVESTMENT'),
    [accounts],
  );

  const { data, isLoading: dataLoading } = useReportData(
    () =>
      investmentsApi.getSectorWeightings(
        config.accountIds.length > 0 ? config.accountIds : undefined,
      ),
    [config.accountIds],
  );

  const chartData = useMemo(
    () =>
      (data?.items ?? []).map((item) => ({
        sector: item.sector,
        direct: item.directValue,
        etf: item.etfValue,
        total: item.totalValue,
        percentage: item.percentage,
      })),
    [data],
  );

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
      title={t('sectorWeightings.title')}
      configControls={configControls}
      configTitle={t('sectorWeightings.title')}
    >
      {loading ? (
        <div className="flex-1 min-h-[260px] animate-pulse rounded-md bg-gray-100 dark:bg-gray-700/50" />
      ) : chartData.length === 0 ? (
        <WidgetMessage>{t('sectorWeightings.empty')}</WidgetMessage>
      ) : (
        <div
          className="flex-1"
          style={{ minHeight: Math.min(Math.max(240, chartData.length * 38 + 40), 420) }}
        >
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <BarChart data={chartData} layout="vertical" margin={{ top: 4, right: 10, left: 0, bottom: 4 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} horizontal={false} />
              <XAxis type="number" tickFormatter={formatCurrencyAxis} tick={{ fontSize: 11 }} />
              <YAxis type="category" dataKey="sector" width={100} tick={{ fontSize: 11 }} />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0].payload as (typeof chartData)[number];
                  return (
                    <ChartTooltipPanel>
                      <p className="font-medium text-gray-900 dark:text-gray-100">{d.sector}</p>
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        {t('sectorWeightings.direct')}: {formatCurrency(d.direct, defaultCurrency)}
                      </p>
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        {t('sectorWeightings.etf')}: {formatCurrency(d.etf, defaultCurrency)}
                      </p>
                      <p className="text-sm text-gray-500 dark:text-gray-400">
                        {d.percentage.toFixed(1)}%
                      </p>
                    </ChartTooltipPanel>
                  );
                }}
              />
              <Legend
                formatter={(value: string) =>
                  value === 'direct' ? t('sectorWeightings.direct') : t('sectorWeightings.etf')
                }
              />
              <Bar dataKey="direct" stackId="a" fill={chartColors.primary} name="direct" />
              <Bar dataKey="etf" stackId="a" fill={chartColors.income} name="etf" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </WidgetCard>
  );
}
