'use client';

import { useRouter } from 'next/navigation';
import { FavouriteSecurityQuote } from '@/types/investment';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { usePreferencesStore } from '@/store/preferencesStore';

interface FavouriteSecuritiesProps {
  securities: FavouriteSecurityQuote[];
  isLoading: boolean;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

function RefreshButton({ onRefresh, isRefreshing }: { onRefresh?: () => void; isRefreshing?: boolean }) {
  if (!onRefresh) return null;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onRefresh(); }}
      disabled={isRefreshing}
      className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors disabled:opacity-50"
      title="Refresh prices"
    >
      <svg
        className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`}
        fill="none"
        stroke="currentColor"
        viewBox="0 0 24 24"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
          d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
        />
      </svg>
    </button>
  );
}

export function FavouriteSecurities({ securities, isLoading, onRefresh, isRefreshing }: FavouriteSecuritiesProps) {
  const router = useRouter();
  const { formatCurrencyPrecise, formatPercent } = useNumberFormat();
  const defaultCurrency = usePreferencesStore((s) => s.preferences?.defaultCurrency) || 'USD';

  if (isLoading) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 lg:min-h-[500px]">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100">
            Favourite Securities
          </h3>
          <div className="flex items-center gap-2">
            <RefreshButton onRefresh={onRefresh} isRefreshing={isRefreshing} />
            <span className="text-sm text-gray-500 dark:text-gray-400">Daily change</span>
          </div>
        </div>
        <div className="animate-pulse space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 bg-gray-200 dark:bg-gray-700 rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (securities.length === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 lg:min-h-[500px]">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
          Favourite Securities
        </h3>
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          No favourite securities yet. Visit the{' '}
          <button
            onClick={() => router.push('/securities')}
            className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
          >
            Securities page
          </button>{' '}
          and star the securities you want to track here.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow dark:shadow-gray-700/50 p-3 sm:p-6 lg:min-h-[500px]">
      <div className="flex items-center justify-between mb-4">
        <button
          onClick={() => router.push('/securities')}
          className="text-lg font-semibold text-gray-900 dark:text-gray-100 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
        >
          Favourite Securities
        </button>
        <div className="flex items-center gap-2">
          <RefreshButton onRefresh={onRefresh} isRefreshing={isRefreshing} />
          <span className="text-sm text-gray-500 dark:text-gray-400">Daily change</span>
        </div>
      </div>
      <div className="space-y-2 sm:space-y-3">
        {securities.map((sec) => {
          const isPositive = sec.dailyChange >= 0;
          const isForeign = sec.currencyCode && sec.currencyCode !== defaultCurrency;
          const fmtPrice = (value: number) => {
            const formatted = formatCurrencyPrecise(value, sec.currencyCode);
            return isForeign ? `${formatted} ${sec.currencyCode}` : formatted;
          };
          return (
            <div
              key={sec.securityId}
              className="flex items-center justify-between p-2 sm:p-3 rounded-lg border border-gray-200 dark:border-gray-700"
            >
              <div className="min-w-0">
                <div className="font-medium text-gray-900 dark:text-gray-100">{sec.symbol}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400 truncate">{sec.name}</div>
              </div>
              <div className="text-right flex-shrink-0 ml-3">
                {sec.currentPrice != null ? (
                  <>
                    <div className="text-sm text-gray-600 dark:text-gray-300">
                      {fmtPrice(sec.currentPrice)}
                    </div>
                    <div
                      className={`text-sm font-medium ${
                        isPositive
                          ? 'text-green-600 dark:text-green-400'
                          : 'text-red-600 dark:text-red-400'
                      }`}
                    >
                      {isPositive ? '+' : ''}
                      {formatCurrencyPrecise(sec.dailyChange, sec.currencyCode)} ({isPositive ? '+' : ''}
                      {formatPercent(sec.dailyChangePercent)})
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-gray-400 dark:text-gray-500">No price yet</div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <button
        onClick={() => router.push('/securities')}
        className="mt-3 w-full text-center text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
      >
        Manage securities
      </button>
    </div>
  );
}
