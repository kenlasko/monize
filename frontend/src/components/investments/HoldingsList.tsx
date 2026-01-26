'use client';

import { HoldingWithMarketValue } from '@/types/investment';

interface HoldingsListProps {
  holdings: HoldingWithMarketValue[];
  isLoading: boolean;
}

export function HoldingsList({ holdings, isLoading }: HoldingsListProps) {
  const formatCurrency = (value: number | null) => {
    if (value === null) return '-';
    return new Intl.NumberFormat('en-CA', {
      style: 'currency',
      currency: 'CAD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  };

  const formatPercent = (value: number | null) => {
    if (value === null) return '-';
    const sign = value >= 0 ? '+' : '';
    return `${sign}${value.toFixed(2)}%`;
  };

  const formatQuantity = (value: number) => {
    return new Intl.NumberFormat('en-CA', {
      minimumFractionDigits: 0,
      maximumFractionDigits: 4,
    }).format(value);
  };

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Holdings
        </h3>
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="animate-pulse flex justify-between">
              <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/4" />
              <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/4" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (holdings.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Holdings
        </h3>
        <p className="text-gray-500 dark:text-gray-400">
          No holdings in this portfolio.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
      <div className="p-6 pb-0">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Holdings
        </h3>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="bg-gray-50 dark:bg-gray-700/50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Symbol
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Shares
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Avg Cost
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Price
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Market Value
              </th>
              <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Gain/Loss
              </th>
            </tr>
          </thead>
          <tbody className="bg-white dark:bg-gray-800 divide-y divide-gray-200 dark:divide-gray-700">
            {holdings.map((holding) => (
              <tr key={holding.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                <td className="px-6 py-4 whitespace-nowrap">
                  <div className="font-medium text-gray-900 dark:text-gray-100">
                    {holding.symbol}
                  </div>
                  <div className="text-sm text-gray-500 dark:text-gray-400 truncate max-w-[150px]">
                    {holding.name}
                  </div>
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-gray-900 dark:text-gray-100">
                  {formatQuantity(holding.quantity)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-gray-900 dark:text-gray-100">
                  {formatCurrency(holding.averageCost)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right text-gray-900 dark:text-gray-100">
                  {formatCurrency(holding.currentPrice)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right font-medium text-gray-900 dark:text-gray-100">
                  {formatCurrency(holding.marketValue)}
                </td>
                <td className="px-6 py-4 whitespace-nowrap text-right">
                  <div
                    className={`font-medium ${
                      (holding.gainLoss ?? 0) >= 0
                        ? 'text-green-600 dark:text-green-400'
                        : 'text-red-600 dark:text-red-400'
                    }`}
                  >
                    {formatCurrency(holding.gainLoss)}
                  </div>
                  <div
                    className={`text-sm ${
                      (holding.gainLossPercent ?? 0) >= 0
                        ? 'text-green-600 dark:text-green-400'
                        : 'text-red-600 dark:text-red-400'
                    }`}
                  >
                    {formatPercent(holding.gainLossPercent)}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
