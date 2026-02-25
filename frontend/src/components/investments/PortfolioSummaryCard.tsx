'use client';

import { useMemo } from 'react';
import { PortfolioSummary } from '@/types/investment';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useExchangeRates } from '@/hooks/useExchangeRates';

function InfoTooltip({ text }: { text: string }) {
  return (
    <span className="relative inline-flex items-center ml-1 group">
      <svg
        className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500 cursor-help"
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <circle cx="12" cy="12" r="10" />
        <path d="M12 16v-4M12 8h.01" />
      </svg>
      <span className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 text-xs font-normal text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg whitespace-normal w-56 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-150 z-10 pointer-events-none">
        {text}
      </span>
    </span>
  );
}

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
      let netInvested = 0;
      for (const acct of summary.holdingsByAccount) {
        cash += acct.cashBalance;
        holdings += acct.totalMarketValue;
        costBasis += acct.totalCostBasis;
        netInvested += acct.netInvested;
      }
      const portfolio = cash + holdings;
      const gainLoss = holdings - costBasis;
      const gainLossPercent = costBasis > 0 ? (gainLoss / costBasis) * 100 : 0;
      return { cash, holdings, costBasis, netInvested, portfolio, gainLoss, gainLossPercent };
    }

    let cash = 0;
    let holdings = 0;
    let costBasis = 0;
    let netInvested = 0;
    for (const acct of summary.holdingsByAccount) {
      cash += convertToDefault(acct.cashBalance, acct.currencyCode);
      holdings += convertToDefault(acct.totalMarketValue, acct.currencyCode);
      costBasis += convertToDefault(acct.totalCostBasis, acct.currencyCode);
      netInvested += convertToDefault(acct.netInvested, acct.currencyCode);
    }
    const portfolio = cash + holdings;
    const gainLoss = holdings - costBasis;
    const gainLossPercent = costBasis > 0 ? (gainLoss / costBasis) * 100 : 0;
    return { cash, holdings, costBasis, netInvested, portfolio, gainLoss, gainLossPercent };
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

  const returnColorClass = (value: number | null | undefined) => {
    if (value == null) return 'text-gray-400 dark:text-gray-500';
    return value >= 0
      ? 'text-green-600 dark:text-green-400'
      : 'text-red-600 dark:text-red-400';
  };

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Portfolio Summary
        </h3>
        <div className="space-y-3">
          {[1, 2, 3, 4, 5].map((i) => (
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
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Portfolio Summary
        </h3>
        <p className="text-gray-500 dark:text-gray-400">
          No investment data available.
        </p>
      </div>
    );
  }

  const gainLossVal = converted?.gainLoss ?? summary.totalGainLoss;
  const gainLossPercentVal = converted?.gainLossPercent ?? summary.totalGainLossPercent;
  const twr = summary.timeWeightedReturn;
  const cagrVal = summary.cagr;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6">
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

        {/* Values Section */}
        <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
          <div className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-3">
            Values
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <div className="text-sm text-gray-500 dark:text-gray-400 flex items-center">
                Holdings Value
                <InfoTooltip text="The current market value of all securities you hold, based on the latest available prices." />
              </div>
              <div className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {fmtVal(converted?.holdings ?? summary.totalHoldingsValue)}
              </div>
            </div>
            <div>
              <div className="text-sm text-gray-500 dark:text-gray-400 flex items-center">
                Cash Balance
                <InfoTooltip text="Uninvested cash sitting in your investment accounts, available for purchasing securities." />
              </div>
              <div className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {fmtVal(converted?.cash ?? summary.totalCashValue)}
              </div>
            </div>
            <div>
              <div className="text-sm text-gray-500 dark:text-gray-400 flex items-center">
                Total Gain
                <InfoTooltip text="The total profit or loss across all your investments: Portfolio Value minus Net Invested. Includes realized gains, unrealized gains, dividends, and interest." />
              </div>
              <div className={`text-lg font-semibold ${returnColorClass((converted?.portfolio ?? summary.totalPortfolioValue) - (converted?.netInvested ?? summary.totalNetInvested))}`}>
                {fmtVal((converted?.portfolio ?? summary.totalPortfolioValue) - (converted?.netInvested ?? summary.totalNetInvested))}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-3 gap-4 mt-3">
            <div>
              <div className="text-sm text-gray-500 dark:text-gray-400 flex items-center">
                Net Invested
                <InfoTooltip text="The net amount of your own money deposited into your investment accounts. This is total contributions minus withdrawals, excluding any investment gains, dividends, or interest earned." />
              </div>
              <div className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {fmtVal(converted?.netInvested ?? summary.totalNetInvested)}
              </div>
            </div>
            <div>
              <div className="text-sm text-gray-500 dark:text-gray-400 flex items-center">
                Cost Basis
                <InfoTooltip text="The total amount you originally paid to acquire your investments, including purchase prices and transaction fees. Used to calculate your gains and losses." />
              </div>
              <div className="text-lg font-semibold text-gray-900 dark:text-gray-100">
                {fmtVal(converted?.costBasis ?? summary.totalCostBasis)}
              </div>
            </div>
            <div>
              <div className="text-sm text-gray-500 dark:text-gray-400 flex items-center">
                Gain/Loss
                <InfoTooltip text="Unrealized gain or loss on your current holdings: Market Value minus Cost Basis. Does not include realized gains from past sales or income received." />
              </div>
              <div className={`text-lg font-semibold ${returnColorClass(gainLossVal)}`}>
                {fmtVal(gainLossVal)}
              </div>
            </div>
          </div>
        </div>

        {/* Returns Section */}
        <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
          <div className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider mb-3">
            Returns
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div>
              <div className="text-sm text-gray-500 dark:text-gray-400 flex items-center">
                Simple Return
                <InfoTooltip text="Total percentage gain or loss on your holdings, calculated as (Market Value − Cost Basis) ÷ Cost Basis. Does not account for the timing of contributions or withdrawals." />
              </div>
              <div className={`text-lg font-semibold ${returnColorClass(gainLossPercentVal)}`}>
                {formatPercent(gainLossPercentVal)}
              </div>
            </div>
            <div>
              <div className="text-sm text-gray-500 dark:text-gray-400 flex items-center">
                Time-Weighted Return
                <InfoTooltip text="Measures how well your investments performed regardless of when you added or removed money. Eliminates the impact of cash flow timing to show pure investment performance." />
              </div>
              <div className={`text-lg font-semibold ${returnColorClass(twr)}`}>
                {twr != null ? formatPercent(twr) : (
                  <span className="text-gray-400 dark:text-gray-500 text-sm font-normal">N/A</span>
                )}
              </div>
            </div>
            <div>
              <div className="text-sm text-gray-500 dark:text-gray-400 flex items-center">
                CAGR
                <InfoTooltip text="Compound Annual Growth Rate. Your annualized return based on Net Invested vs. current portfolio value, as if growth had been perfectly steady each year." />
              </div>
              <div className={`text-lg font-semibold ${returnColorClass(cagrVal)}`}>
                {cagrVal != null ? formatPercent(cagrVal) : (
                  <span className="text-gray-400 dark:text-gray-500 text-sm font-normal">N/A</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
