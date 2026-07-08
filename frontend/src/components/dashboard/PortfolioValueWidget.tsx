'use client';

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { parseISO } from 'date-fns';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { Account } from '@/types/account';
import { netWorthApi } from '@/lib/net-worth';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';
import { useReportData } from '@/hooks/useReportData';
import { useChartDateFormat } from '@/hooks/useChartDateFormat';
import { useWidgetConfig } from '@/hooks/useWidgetConfig';
import { resolveRangePreset } from '@/lib/date-range';
import { chartColors } from '@/lib/chart-colors';
import { ChartTooltipPanel } from '@/components/reports/ChartTooltip';
import { DateRangeSelector } from '@/components/ui/DateRangeSelector';
import { ReportAccountMultiSelect } from '@/components/reports/ReportAccountMultiSelect';
import { WidgetCard, WidgetConfigRow, WidgetMessage } from './WidgetCard';
import {
  PORTFOLIO_VALUE_DEFAULT,
  PORTFOLIO_RANGES,
  PortfolioValueConfig,
} from './widget-config';

const WIDGET_ID = 'portfolio-value';

// Short ranges render at daily resolution; longer ones use monthly snapshots so
// the series stays readable without thousands of points.
const DAILY_RANGES = new Set(['3m', '6m']);

const excludeCashAccounts = (a: Account) => a.accountSubType !== 'INVESTMENT_CASH';

interface PortfolioValueWidgetProps {
  accounts: Account[];
  isLoading: boolean;
}

export function PortfolioValueWidget({ accounts, isLoading }: PortfolioValueWidgetProps) {
  const t = useTranslations('dashboard');
  const { formatCurrency, formatCurrencyAxis } = useNumberFormat();
  const { defaultCurrency } = useExchangeRates();
  const formatChartDate = useChartDateFormat();
  const { config, updateConfig } = useWidgetConfig<PortfolioValueConfig>(
    WIDGET_ID,
    PORTFOLIO_VALUE_DEFAULT,
  );

  const investmentAccounts = useMemo(
    () => accounts.filter((a) => a.accountType === 'INVESTMENT'),
    [accounts],
  );

  const isDaily = DAILY_RANGES.has(config.range);
  const { start, end } = useMemo(
    () => resolveRangePreset(config.range, { alignment: isDaily ? 'day' : 'month' }),
    [config.range, isDaily],
  );

  const accountIdsCsv =
    config.accountIds.length > 0 ? config.accountIds.join(',') : undefined;

  const { data: series, isLoading: dataLoading } = useReportData(() => {
    const params = {
      startDate: start || undefined,
      endDate: end,
      accountIds: accountIdsCsv,
      displayCurrency: defaultCurrency,
    };
    return isDaily
      ? netWorthApi
          .getInvestmentsDaily(params)
          .then((rows) => rows.map((r) => ({ date: r.date, value: r.value })))
      : netWorthApi
          .getInvestmentsMonthly(params)
          .then((rows) => rows.map((r) => ({ date: r.month, value: r.value })));
  }, [start, end, accountIdsCsv, defaultCurrency, isDaily]);

  const chartData = useMemo(
    () =>
      (series ?? []).map((row) => {
        const parsed = parseISO(row.date.length === 7 ? `${row.date}-01` : row.date);
        return {
          date: row.date,
          label: formatChartDate(parsed, isDaily ? 'MMM d' : 'MMM yyyy'),
          value: Math.round(row.value),
        };
      }),
    [series, formatChartDate, isDaily],
  );

  const latestValue = chartData.length > 0 ? chartData[chartData.length - 1].value : 0;

  const configControls = (
    <>
      <WidgetConfigRow label={t('widgets.timeframe')}>
        <DateRangeSelector
          ranges={PORTFOLIO_RANGES}
          value={config.range}
          onChange={(range) => updateConfig({ range })}
          size="sm"
        />
      </WidgetConfigRow>
      <WidgetConfigRow label={t('widgets.accounts')}>
        <ReportAccountMultiSelect
          accounts={investmentAccounts}
          value={config.accountIds}
          onChange={(accountIds) => updateConfig({ accountIds })}
          filter={excludeCashAccounts}
          className="w-full"
        />
      </WidgetConfigRow>
    </>
  );

  const loading = isLoading || dataLoading;

  return (
    <WidgetCard
      title={t('portfolioValue.title')}
      headerRight={
        !loading && latestValue > 0 ? (
          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100">
            {formatCurrency(latestValue, defaultCurrency)}
          </span>
        ) : undefined
      }
      configControls={configControls}
      configTitle={t('portfolioValue.title')}
    >
      {loading ? (
        <div className="flex-1 min-h-[260px] animate-pulse rounded-md bg-gray-100 dark:bg-gray-700/50" />
      ) : chartData.length === 0 ? (
        <WidgetMessage>{t('portfolioValue.empty')}</WidgetMessage>
      ) : (
        <div className="flex-1 min-h-[260px]">
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <AreaChart data={chartData} margin={{ left: 4, right: 8, top: 4 }}>
              <defs>
                <linearGradient id="portfolioValueGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor={chartColors.primary} stopOpacity={0.35} />
                  <stop offset="95%" stopColor={chartColors.primary} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke={chartColors.grid} />
              <XAxis
                dataKey="date"
                tickFormatter={(value) => chartData.find((d) => d.date === value)?.label ?? String(value)}
                tick={{ fontSize: 11 }}
                minTickGap={24}
              />
              <YAxis tickFormatter={formatCurrencyAxis} tick={{ fontSize: 11 }} width={56} domain={['auto', 'auto']} />
              <Tooltip
                content={({ active, payload }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0].payload as (typeof chartData)[number];
                  return (
                    <ChartTooltipPanel>
                      <p className="font-medium text-gray-900 dark:text-gray-100">{d.label}</p>
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        {formatCurrency(d.value, defaultCurrency)}
                      </p>
                    </ChartTooltipPanel>
                  );
                }}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke={chartColors.primary}
                strokeWidth={2}
                fill="url(#portfolioValueGradient)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </WidgetCard>
  );
}
