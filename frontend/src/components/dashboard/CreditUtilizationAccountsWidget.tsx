'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';
import { Account } from '@/types/account';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useWidgetConfig } from '@/hooks/useWidgetConfig';
import { chartColors } from '@/lib/chart-colors';
import {
  isCreditAccount,
  utilizationColour,
  computeCreditRows,
} from '@/lib/credit-utilization';
import { ChartTooltipPanel } from '@/components/reports/ChartTooltip';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { WidgetCard, WidgetConfigRow, WidgetMessage } from './WidgetCard';
import { CREDIT_UTILIZATION_ACCOUNTS_DEFAULT, AccountsConfig } from './widget-config';

const WIDGET_ID = 'credit-utilization-accounts';

interface CreditUtilizationAccountsWidgetProps {
  accounts: Account[];
  isLoading: boolean;
}

export function CreditUtilizationAccountsWidget({
  accounts,
  isLoading,
}: CreditUtilizationAccountsWidgetProps) {
  const t = useTranslations('dashboard');
  const { formatCurrency } = useNumberFormat();
  const { convert, defaultCurrency } = useExchangeRates();
  const { config, updateConfig } = useWidgetConfig<AccountsConfig>(
    WIDGET_ID,
    CREDIT_UTILIZATION_ACCOUNTS_DEFAULT,
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

  const rows = useMemo(
    () =>
      computeCreditRows(activeAccounts, convert, displayCurrency).sort(
        (a, b) => b.utilizationPercent - a.utilizationPercent,
      ),
    [activeAccounts, convert, displayCurrency],
  );

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

  const chartMinHeight = Math.max(220, rows.length * 44);

  return (
    <WidgetCard
      title={t('creditUtilizationAccounts.title')}
      configControls={creditAccounts.length > 0 ? configControls : undefined}
      configTitle={t('creditUtilizationAccounts.title')}
    >
      {isLoading ? (
        <div className="flex-1 min-h-[260px] animate-pulse rounded-md bg-gray-100 dark:bg-gray-700/50" />
      ) : rows.length === 0 ? (
        <WidgetMessage>{t('creditUtilizationAccounts.empty')}</WidgetMessage>
      ) : (
        <div className="flex-1" style={{ minHeight: Math.min(chartMinHeight, 420) }}>
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <BarChart data={rows} layout="vertical" margin={{ left: 8, right: 24 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} horizontal={false} />
              <XAxis
                type="number"
                domain={[0, 100]}
                tickFormatter={(v: number) => `${v}%`}
                tick={{ fontSize: 11 }}
              />
              <YAxis type="category" dataKey="name" width={110} tick={{ fontSize: 11 }} />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const row = payload[0].payload as (typeof rows)[number];
                  return (
                    <ChartTooltipPanel>
                      <p className="font-medium text-gray-900 dark:text-gray-100">{row.name}</p>
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        {t('creditUtilizationAccounts.utilization')}: {row.utilizationPercent.toFixed(1)}%
                      </p>
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        {t('creditUtilizationAccounts.used')}: {formatCurrency(row.used, displayCurrency)}
                      </p>
                    </ChartTooltipPanel>
                  );
                }}
              />
              <ReferenceLine x={100} stroke={chartColors.axis} strokeDasharray="4 4" />
              <Bar dataKey="utilizationPercent" radius={[0, 4, 4, 0]} maxBarSize={28}>
                {rows.map((row) => (
                  <Cell key={row.id} fill={utilizationColour(row.utilizationPercent)} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </WidgetCard>
  );
}
