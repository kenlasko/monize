'use client';

import { useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { chartColors } from '@/lib/chart-colors';
import { MonthlyNetWorth } from '@/types/net-worth';
import { useNumberFormat } from '@/hooks/useNumberFormat';

interface AssetsVsLiabilitiesProps {
  data: MonthlyNetWorth[];
  isLoading: boolean;
}

const ASSET_COLOUR = chartColors.income;
const LIABILITY_COLOUR = chartColors.expense;

function AssetsTooltip({
  active,
  payload,
  total,
  formatCurrency,
}: {
  active?: boolean;
  payload?: Array<{ payload: { name: string; value: number } }>;
  total: number;
  formatCurrency: (v: number) => string;
}) {
  if (active && payload && payload.length) {
    const d = payload[0].payload;
    const percentage = total > 0 ? ((d.value / total) * 100).toFixed(1) : '0';
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
        <p className="font-medium text-gray-900 dark:text-gray-100">{d.name}</p>
        <p className="text-gray-600 dark:text-gray-400">
          {formatCurrency(d.value)} ({percentage}%)
        </p>
      </div>
    );
  }
  return null;
}

export function AssetsVsLiabilities({ data, isLoading }: AssetsVsLiabilitiesProps) {
  const t = useTranslations('dashboard');
  const router = useRouter();
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();

  // The net-worth series carries assets and liabilities per month; the pie
  // reflects the most recent month's split.
  const latest = useMemo(() => (data.length > 0 ? data[data.length - 1] : null), [data]);

  const chartData = useMemo(() => {
    if (!latest) return [];
    return [
      { name: t('assetsVsLiabilities.assets'), value: Math.round(latest.assets), colour: ASSET_COLOUR },
      { name: t('assetsVsLiabilities.liabilities'), value: Math.round(latest.liabilities), colour: LIABILITY_COLOUR },
    ].filter((d) => d.value > 0);
  }, [latest, t]);

  const netWorth = latest ? Math.round(latest.netWorth) : 0;
  const total = chartData.reduce((sum, item) => sum + item.value, 0);

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 lg:min-h-[500px]">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('assetsVsLiabilities.title')}
        </h3>
        <div className="h-64 flex items-center justify-center">
          <div className="animate-pulse w-48 h-48 rounded-full bg-gray-200 dark:bg-gray-700" />
        </div>
      </div>
    );
  }

  if (chartData.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 lg:min-h-[500px]">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          {t('assetsVsLiabilities.title')}
        </h3>
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          {t('assetsVsLiabilities.empty')}
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 lg:min-h-[500px] flex flex-col h-full">
      <div className="flex items-center justify-between mb-1">
        <button
          onClick={() => router.push('/reports/net-worth')}
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
        >
          {t('assetsVsLiabilities.title')}
        </button>
        <span className="text-sm text-gray-500 dark:text-gray-400">{t('assetsVsLiabilities.current')}</span>
      </div>
      <div className="flex-1 min-h-[16rem]">
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              innerRadius={55}
              outerRadius={85}
              paddingAngle={2}
              dataKey="value"
            >
              {chartData.map((entry) => (
                <Cell key={entry.name} fill={entry.colour} />
              ))}
            </Pie>
            <Tooltip content={<AssetsTooltip total={total} formatCurrency={formatCurrency} />} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 flex justify-center gap-4">
        {chartData.map((item) => (
          <div key={item.name} className="flex items-center gap-2 text-sm">
            <div className="w-3 h-3 rounded-full flex-shrink-0" style={{ backgroundColor: item.colour }} />
            <span className="text-gray-600 dark:text-gray-400">{item.name}</span>
            <span className="font-medium text-gray-900 dark:text-gray-100">{formatCurrency(item.value)}</span>
          </div>
        ))}
      </div>
      <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700 text-center flex-shrink-0">
        <div className="text-sm text-gray-500 dark:text-gray-400">{t('assetsVsLiabilities.netWorthLabel')}</div>
        <div className={`font-semibold ${netWorth >= 0 ? 'text-gray-900 dark:text-gray-100' : 'text-red-600 dark:text-red-400'}`}>
          {formatCurrency(netWorth)}
        </div>
      </div>
    </div>
  );
}
