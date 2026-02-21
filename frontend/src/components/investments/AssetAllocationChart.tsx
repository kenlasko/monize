'use client';

import { useMemo } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { AssetAllocation, AccountHoldings } from '@/types/investment';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';

function AllocationTooltip({
  active,
  payload,
  fmtVal,
  foreignCurrency,
  foreignTotal,
}: {
  active?: boolean;
  payload?: Array<{
    payload: { fullName: string; value: number; percentage: number; currencyCode?: string };
  }>;
  fmtVal: (v: number) => string;
  foreignCurrency: string | null;
  foreignTotal: number;
}) {
  if (active && payload && payload.length) {
    const data = payload[0].payload;
    const displayValue = foreignCurrency
      ? (data.percentage / 100) * foreignTotal
      : data.value;
    return (
      <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-lg p-3">
        <p className="font-medium text-gray-900 dark:text-gray-100">
          {data.fullName}
        </p>
        <p className="text-gray-600 dark:text-gray-400">
          {fmtVal(displayValue)} ({data.percentage.toFixed(1)}%)
        </p>
      </div>
    );
  }
  return null;
}

interface AssetAllocationChartProps {
  allocation: AssetAllocation | null;
  isLoading: boolean;
  singleAccountCurrency?: string | null;
  holdingsByAccount?: AccountHoldings[];
}

export function AssetAllocationChart({
  allocation,
  isLoading,
  singleAccountCurrency,
  holdingsByAccount,
}: AssetAllocationChartProps) {
  const { formatCurrencyCompact: formatCurrency } = useNumberFormat();
  const { defaultCurrency } = useExchangeRates();

  // When viewing a single foreign-currency account, show values in that currency
  const foreignCurrency = singleAccountCurrency && singleAccountCurrency !== defaultCurrency
    ? singleAccountCurrency
    : null;

  // Compute raw total in the foreign currency from holdingsByAccount
  const foreignTotal = useMemo(() => {
    if (!foreignCurrency || !holdingsByAccount) return 0;
    let total = 0;
    for (const acct of holdingsByAccount) {
      total += acct.cashBalance + acct.totalMarketValue;
    }
    return total;
  }, [foreignCurrency, holdingsByAccount]);

  const fmtVal = (value: number) => {
    if (foreignCurrency) return `${formatCurrency(value, foreignCurrency)} ${foreignCurrency}`;
    return formatCurrency(value);
  };

  const chartData = useMemo(() => {
    if (!allocation) return [];
    return allocation.allocation.map((item) => ({
      name: item.symbol || item.name,
      fullName: item.name,
      value: item.value,
      percentage: item.percentage,
      color: item.color || '#6b7280',
      currencyCode: item.currencyCode,
    }));
  }, [allocation]);

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Asset Allocation
        </h3>
        <div className="h-64 flex items-center justify-center">
          <div className="animate-pulse w-48 h-48 rounded-full bg-gray-200 dark:bg-gray-700" />
        </div>
      </div>
    );
  }

  if (!allocation || allocation.allocation.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Asset Allocation
        </h3>
        <p className="text-gray-500 dark:text-gray-400">
          No allocation data available.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        Asset Allocation
      </h3>
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={chartData}
              cx="50%"
              cy="50%"
              innerRadius={50}
              outerRadius={80}
              paddingAngle={2}
              dataKey="value"
            >
              {chartData.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={entry.color} />
              ))}
            </Pie>
            <Tooltip content={<AllocationTooltip fmtVal={fmtVal} foreignCurrency={foreignCurrency} foreignTotal={foreignTotal} />} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-4 grid grid-cols-2 gap-2">
        {chartData.slice(0, 10).map((item, index) => {
          const isForeign = !foreignCurrency && item.currencyCode && item.currencyCode !== defaultCurrency;
          return (
            <div key={index} className="flex items-center gap-2 text-sm">
              <div
                className="w-3 h-3 rounded-full flex-shrink-0"
                style={{ backgroundColor: item.color }}
              />
              <span className="text-gray-600 dark:text-gray-400 truncate">
                {item.name}
                {isForeign && (
                  <span className="ml-1 text-xs text-amber-600 dark:text-amber-400">({item.currencyCode})</span>
                )}
              </span>
              <span className="text-gray-900 dark:text-gray-100 ml-auto">
                {item.percentage.toFixed(1)}%
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
