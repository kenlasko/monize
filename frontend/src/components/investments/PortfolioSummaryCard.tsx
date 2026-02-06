'use client';

import { useMemo } from 'react';
import { PortfolioSummary } from '@/types/investment';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';

interface PortfolioSummaryCardProps {
  summary: PortfolioSummary | null;
  isLoading: boolean;
  singleAccountCurrency?: string | null;
}

export function PortfolioSummaryCard({
  summary,
  isLoading,
  singleAccountCurrency,
}: PortfolioSummaryCardProps) {
  const { formatCurrency } = useNumberFormat();
  const { convertToDefault, defaultCurrency } = useExchangeRates();

  // When viewing a single foreign-currency account, show values in that currency
  const foreignCurrency = singleAccountCurrency && singleAccountCurrency !== defaultCurrency
    ? singleAccountCurrency
    : null;

  const converted = useMemo(() => {
    if (!summary) return null;

    if (foreignCurrency) {
      // Single foreign account: use raw values without conversion
      let cash = 0;
      let holdings = 0;
      let costBasis = 0;
      for (const acct of summary.holdingsByAccount) {
        cash += acct.cashBalance;
        holdings += acct.totalMarketValue;
        costBasis += acct.totalCostBasis;
      }
      const portfolio = cash + holdings;
      const gainLoss = holdings - costBasis;
      const gainLossPercent = costBasis > 0 ? (gainLoss / costBasis) * 100 : 0;
      return { cash, holdings, costBasis, portfolio, gainLoss, gainLossPercent };
    }

    let cash = 0;
    let holdings = 0;
    let costBasis = 0;
    for (const acct of summary.holdingsByAccount) {
      cash += convertToDefault(acct.cashBalance, acct.currencyCode);
      holdings += convertToDefault(acct.totalMarketValue, acct.currencyCode);
      costBasis += convertToDefault(acct.totalCostBasis, acct.currencyCode);
    }
    const portfolio = cash + holdings;
    const gainLoss = holdings - costBasis;
    const gainLossPercent = costBasis > 0 ? (gainLoss / costBasis) * 100 : 0;
    return { cash, holdings, costBasis, portfolio, gainLoss, gainLossPercent };
  }, [summary, convertToDefault, foreignCurrency]);

  // Compute default-currency total when showing foreign, for the "approx" line
  const defaultTotal = useMemo(() => {
    if (!summary || !foreignCurrency) return null;
    let total = 0;
    for (const acct of summary.holdingsByAccount) {
      total += convertToDefault(acct.cashBalance, acct.currencyCode);
      total += convertToDefault(acct.totalMarketValue, acct.currencyCode);
    }
    return total;
  }, [summary, convertToDefault, foreignCurrency]);

  const fmtVal = (value: number) => {
    if (foreignCurrency) return `${formatCurrency(value, foreignCurrency)} ${foreignCurrency}`;
    return formatCurrency(value);
  };

  const formatPercent = (value: number) => {
    const sign = value >= 0 ? '+' : '';
    return `${sign}${value.toFixed(2)}%`;
  };

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Portfolio Summary
        </h3>
        <div className="space-y-3">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="animate-pulse">
              <div className="h-4 bg-gray-200 dark:bg-gray-700 rounded w-1/3 mb-1" />
              <div className="h-6 bg-gray-200 dark:bg-gray-700 rounded w-1/2" />
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Portfolio Summary
        </h3>
        <p className="text-gray-500 dark:text-gray-400">
          No investment data available.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
      <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
        Portfolio Summary
      </h3>

      <div className="space-y-4">
        {/* Total Portfolio Value */}
        <div>
          <div className="text-sm text-gray-500 dark:text-gray-400">
            Total Portfolio Value
          </div>
          <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">
            {fmtVal(converted?.portfolio ?? summary.totalPortfolioValue)}
          </div>
          {foreignCurrency && defaultTotal !== null && (
            <div className="text-xs text-gray-400 dark:text-gray-500">
              {'\u2248 '}{formatCurrency(defaultTotal, defaultCurrency)} {defaultCurrency}
            </div>
          )}
        </div>

        {/* Breakdown */}
        <div className="grid grid-cols-2 gap-4 pt-4 border-t border-gray-200 dark:border-gray-700">
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              Holdings Value
            </div>
            <div className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {fmtVal(converted?.holdings ?? summary.totalHoldingsValue)}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500 dark:text-gray-400">
              Cash Balance
            </div>
            <div className="text-lg font-semibold text-gray-900 dark:text-gray-100">
              {fmtVal(converted?.cash ?? summary.totalCashValue)}
            </div>
          </div>
        </div>

        {/* Gain/Loss */}
        <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
          <div className="text-sm text-gray-500 dark:text-gray-400">
            Total Gain/Loss
          </div>
          <div className="flex items-baseline gap-2">
            <span
              className={`text-lg font-semibold ${
                (converted?.gainLoss ?? summary.totalGainLoss) >= 0
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-red-600 dark:text-red-400'
              }`}
            >
              {fmtVal(converted?.gainLoss ?? summary.totalGainLoss)}
            </span>
            <span
              className={`text-sm ${
                (converted?.gainLossPercent ?? summary.totalGainLossPercent) >= 0
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-red-600 dark:text-red-400'
              }`}
            >
              ({formatPercent(converted?.gainLossPercent ?? summary.totalGainLossPercent)})
            </span>
          </div>
        </div>

        {/* Cost Basis */}
        <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
          <div className="text-sm text-gray-500 dark:text-gray-400">
            Total Cost Basis
          </div>
          <div className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            {fmtVal(converted?.costBasis ?? summary.totalCostBasis)}
          </div>
        </div>
      </div>
    </div>
  );
}
