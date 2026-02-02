'use client';

import { useState } from 'react';
import { AccountHoldings, HoldingWithMarketValue } from '@/types/investment';
import { ChevronDownIcon, ChevronRightIcon } from '@heroicons/react/24/outline';
import { useNumberFormat } from '@/hooks/useNumberFormat';

interface GroupedHoldingsListProps {
  holdingsByAccount: AccountHoldings[];
  isLoading: boolean;
  totalPortfolioValue: number;
  onSymbolClick?: (symbol: string) => void;
  onCashClick?: (cashAccountId: string) => void;
}

export function GroupedHoldingsList({
  holdingsByAccount,
  isLoading,
  totalPortfolioValue,
  onSymbolClick,
  onCashClick,
}: GroupedHoldingsListProps) {
  const { formatCurrency: formatCurrencyBase, numberFormat } = useNumberFormat();

  const [expandedAccounts, setExpandedAccounts] = useState<Set<string>>(
    new Set(holdingsByAccount.map((a) => a.accountId)),
  );

  const toggleAccount = (accountId: string) => {
    setExpandedAccounts((prev) => {
      const next = new Set(prev);
      if (next.has(accountId)) {
        next.delete(accountId);
      } else {
        next.add(accountId);
      }
      return next;
    });
  };

  const formatCurrency = (value: number | null) => {
    if (value === null) return '-';
    return formatCurrencyBase(value);
  };

  const formatPercent = (value: number | null, showSign = true) => {
    if (value === null) return '-';
    const sign = showSign && value >= 0 ? '+' : '';
    return `${sign}${value.toFixed(2)}%`;
  };

  const formatQuantity = (value: number) => {
    const locale = numberFormat === 'browser' ? undefined : numberFormat;
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 4,
    }).format(value);
  };

  const getGainLossColor = (value: number | null) => {
    if (value === null) return 'text-gray-500 dark:text-gray-400';
    return value >= 0
      ? 'text-green-600 dark:text-green-400'
      : 'text-red-600 dark:text-red-400';
  };

  const getPortfolioPercent = (value: number | null): string => {
    if (value === null || totalPortfolioValue === 0) return '-';
    return ((value / totalPortfolioValue) * 100).toFixed(1) + '%';
  };

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Holdings by Account
        </h3>
        <div className="space-y-4">
          {[1, 2].map((i) => (
            <div key={i} className="animate-pulse">
              <div className="h-6 bg-gray-200 dark:bg-gray-700 rounded w-1/3 mb-3" />
              <div className="space-y-2">
                {[1, 2, 3].map((j) => (
                  <div key={j} className="flex justify-between">
                    <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/4" />
                    <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/4" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const totalHoldings = holdingsByAccount.reduce(
    (sum, a) => sum + a.holdings.length,
    0,
  );

  const hasCash = holdingsByAccount.some((a) => a.cashBalance !== 0);

  if (totalHoldings === 0 && !hasCash) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Holdings by Account
        </h3>
        <p className="text-gray-500 dark:text-gray-400">
          No holdings in your portfolio.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 overflow-hidden">
      <div className="p-6 pb-4 border-b border-gray-200 dark:border-gray-700">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
          Holdings by Account
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          {holdingsByAccount.length} account{holdingsByAccount.length !== 1 ? 's' : ''} with {totalHoldings} position{totalHoldings !== 1 ? 's' : ''}
        </p>
      </div>

      <div className="divide-y divide-gray-200 dark:divide-gray-700">
        {holdingsByAccount.map((account) => {
          const isExpanded = expandedAccounts.has(account.accountId);
          const accountTotalValue = account.totalMarketValue + account.cashBalance;

          return (
            <div key={account.accountId}>
              {/* Account Header */}
              <button
                onClick={() => toggleAccount(account.accountId)}
                className="w-full px-6 py-4 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/30 transition-colors"
              >
                <div className="flex items-center gap-3">
                  {isExpanded ? (
                    <ChevronDownIcon className="h-5 w-5 text-gray-400" />
                  ) : (
                    <ChevronRightIcon className="h-5 w-5 text-gray-400" />
                  )}
                  <div className="text-left">
                    <div className="font-semibold text-gray-900 dark:text-gray-100">
                      {account.accountName}
                    </div>
                    <div className="text-sm text-gray-500 dark:text-gray-400">
                      {account.holdings.length} position{account.holdings.length !== 1 ? 's' : ''}
                      {account.cashBalance !== 0 && ' + Cash'}
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-semibold text-gray-900 dark:text-gray-100">
                    {formatCurrency(accountTotalValue)}
                  </div>
                  <div className={`text-sm ${getGainLossColor(account.totalGainLoss)}`}>
                    {formatCurrency(account.totalGainLoss)} ({formatPercent(account.totalGainLossPercent)})
                  </div>
                </div>
              </button>

              {/* Account Holdings Table */}
              {isExpanded && (
                <div className="overflow-x-auto">
                  <table className="min-w-full">
                    <thead className="bg-gray-50 dark:bg-gray-700/50">
                      <tr>
                        <th className="px-6 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          Symbol
                        </th>
                        <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          Shares
                        </th>
                        <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          Avg Cost
                        </th>
                        <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          Price
                        </th>
                        <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          Cost Basis
                        </th>
                        <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          Mkt Value
                        </th>
                        <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          Gain/Loss
                        </th>
                        <th className="px-4 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                          % Port
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 dark:divide-gray-700/50">
                      {account.holdings.map((holding) => (
                        <HoldingRow
                          key={holding.id}
                          holding={holding}
                          formatCurrency={formatCurrency}
                          formatQuantity={formatQuantity}
                          formatPercent={formatPercent}
                          getGainLossColor={getGainLossColor}
                          getPortfolioPercent={getPortfolioPercent}
                          onSymbolClick={onSymbolClick}
                        />
                      ))}

                      {/* Cash Row */}
                      {account.cashBalance !== 0 && (
                        <tr className="hover:bg-gray-50 dark:hover:bg-gray-700/20">
                          <td className="px-6 py-3 whitespace-nowrap">
                            <button
                              onClick={() => account.cashAccountId && onCashClick?.(account.cashAccountId)}
                              className="flex items-center gap-2 text-left hover:underline focus:outline-none focus:underline"
                              title="Click to view cash account transactions"
                            >
                              <svg className="h-4 w-4 text-green-600 dark:text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                              <div>
                                <div className="font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300">Cash</div>
                                <div className="text-xs text-gray-500 dark:text-gray-400">Available Balance</div>
                              </div>
                            </button>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-400 dark:text-gray-500">
                            -
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-400 dark:text-gray-500">
                            -
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-400 dark:text-gray-500">
                            -
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-500 dark:text-gray-400">
                            {formatCurrency(account.cashBalance)}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-right text-sm font-medium text-gray-900 dark:text-gray-100">
                            {formatCurrency(account.cashBalance)}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-right">
                            <div className="text-sm text-gray-400 dark:text-gray-500">-</div>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-500 dark:text-gray-400">
                            {getPortfolioPercent(account.cashBalance)}
                          </td>
                        </tr>
                      )}

                      {/* Account Summary Row */}
                      <tr className="bg-gray-50 dark:bg-gray-700/30 font-medium">
                        <td className="px-6 py-3 text-sm text-gray-700 dark:text-gray-300" colSpan={4}>
                          Account Total
                        </td>
                        <td className="px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100">
                          {formatCurrency(account.totalCostBasis + account.cashBalance)}
                        </td>
                        <td className="px-4 py-3 text-right text-sm text-gray-900 dark:text-gray-100">
                          {formatCurrency(accountTotalValue)}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className={`text-sm ${getGainLossColor(account.totalGainLoss)}`}>
                            {formatCurrency(account.totalGainLoss)}
                          </div>
                          <div className={`text-xs ${getGainLossColor(account.totalGainLossPercent)}`}>
                            {formatPercent(account.totalGainLossPercent)}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right text-sm text-gray-500 dark:text-gray-400">
                          {getPortfolioPercent(accountTotalValue)}
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

interface HoldingRowProps {
  holding: HoldingWithMarketValue;
  formatCurrency: (value: number | null) => string;
  formatQuantity: (value: number) => string;
  formatPercent: (value: number | null, showSign?: boolean) => string;
  getGainLossColor: (value: number | null) => string;
  getPortfolioPercent: (value: number | null) => string;
  onSymbolClick?: (symbol: string) => void;
}

function HoldingRow({
  holding,
  formatCurrency,
  formatQuantity,
  formatPercent,
  getGainLossColor,
  getPortfolioPercent,
  onSymbolClick,
}: HoldingRowProps) {
  return (
    <tr className="hover:bg-gray-50 dark:hover:bg-gray-700/20">
      <td className="px-6 py-3 whitespace-nowrap">
        <button
          onClick={() => onSymbolClick?.(holding.symbol)}
          className="text-left hover:underline focus:outline-none focus:underline"
          title="Click to filter transactions by this symbol"
        >
          <div className="font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300">
            {holding.symbol}
          </div>
          <div className="text-xs text-gray-500 dark:text-gray-400 truncate max-w-[320px]">
            {holding.name}
          </div>
        </button>
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-900 dark:text-gray-100">
        {formatQuantity(holding.quantity)}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-900 dark:text-gray-100">
        {formatCurrency(holding.averageCost)}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-900 dark:text-gray-100">
        {formatCurrency(holding.currentPrice)}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-500 dark:text-gray-400">
        {formatCurrency(holding.costBasis)}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-right text-sm font-medium text-gray-900 dark:text-gray-100">
        {formatCurrency(holding.marketValue)}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-right">
        <div className={`text-sm font-medium ${getGainLossColor(holding.gainLoss)}`}>
          {formatCurrency(holding.gainLoss)}
        </div>
        <div className={`text-xs ${getGainLossColor(holding.gainLossPercent)}`}>
          {formatPercent(holding.gainLossPercent)}
        </div>
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-right text-sm text-gray-500 dark:text-gray-400">
        {getPortfolioPercent(holding.marketValue)}
      </td>
    </tr>
  );
}
