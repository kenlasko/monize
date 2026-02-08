'use client';

import { useRouter } from 'next/navigation';
import { TopMover } from '@/types/investment';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { usePreferencesStore } from '@/store/preferencesStore';

interface TopMoversProps {
  movers: TopMover[];
  isLoading: boolean;
  hasInvestmentAccounts: boolean;
}

export function TopMovers({ movers, isLoading, hasInvestmentAccounts }: TopMoversProps) {
  const router = useRouter();
  const { formatCurrency, formatPercent } = useNumberFormat();
  const defaultCurrency = usePreferencesStore((s) => s.preferences?.defaultCurrency) || 'USD';

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <button
          onClick={() => router.push('/investments')}
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors mb-4"
        >
          Top Movers
        </button>
        <div className="animate-pulse space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 bg-gray-200 dark:bg-gray-700 rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (movers.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
        <button
          onClick={() => router.push('/investments')}
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors mb-4"
        >
          Top Movers
        </button>
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          {hasInvestmentAccounts
            ? 'No price changes available yet.'
            : 'Add investment accounts to track daily movers.'}
        </p>
      </div>
    );
  }

  // Show top 5 movers
  const topMovers = movers.slice(0, 5);

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-6">
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => router.push('/investments')}
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
        >
          Top Movers
        </button>
        <span className="text-sm text-gray-500 dark:text-gray-400">Daily change</span>
      </div>
      <div className="space-y-3">
        {topMovers.map((mover) => {
          const isPositive = mover.dailyChange >= 0;
          const isForeign = mover.currencyCode && mover.currencyCode !== defaultCurrency;
          const fmtPrice = (value: number) => {
            const formatted = formatCurrency(value, mover.currencyCode);
            return isForeign ? `${formatted} ${mover.currencyCode}` : formatted;
          };
          return (
            <div
              key={mover.securityId}
              className="flex items-center justify-between p-3 rounded-lg border border-gray-200 dark:border-gray-700"
            >
              <div className="min-w-0">
                <div className="font-medium text-gray-900 dark:text-gray-100">
                  {mover.symbol}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                  {mover.name}
                </div>
              </div>
              <div className="text-right flex-shrink-0 ml-3">
                <div className="text-sm text-gray-600 dark:text-gray-300">
                  {fmtPrice(mover.currentPrice)}
                </div>
                <div
                  className={`text-sm font-medium ${
                    isPositive
                      ? 'text-green-600 dark:text-green-400'
                      : 'text-red-600 dark:text-red-400'
                  }`}
                >
                  {isPositive ? '+' : ''}{formatCurrency(mover.dailyChange, mover.currencyCode)} ({isPositive ? '+' : ''}{formatPercent(mover.dailyChangePercent)})
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <button
        onClick={() => router.push('/investments')}
        className="mt-3 w-full text-center text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
      >
        View portfolio
      </button>
    </div>
  );
}
