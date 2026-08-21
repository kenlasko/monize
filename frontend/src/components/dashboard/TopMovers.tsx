'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { TopMover } from '@/types/investment';
import { WidgetHeading } from './widget-meta';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { usePreferencesStore } from '@/store/preferencesStore';
import { CARD_CLASS } from '@/components/ui/Card';

type MoverFilter = 'all' | 'gainers' | 'losers';

const FILTER_STORAGE_KEY = 'dashboard.topMovers.filter';

function getStoredFilter(): MoverFilter {
  if (typeof window === 'undefined') return 'all';
  try {
    const stored = localStorage.getItem(FILTER_STORAGE_KEY);
    return stored === 'gainers' || stored === 'losers' || stored === 'all' ? stored : 'all';
  } catch {
    return 'all';
  }
}

interface TopMoversProps {
  movers: TopMover[];
  isLoading: boolean;
  hasInvestmentAccounts: boolean;
  onRefresh?: () => void;
  isRefreshing?: boolean;
}

function MoverFilterControl({
  filter,
  onChange,
}: {
  filter: MoverFilter;
  onChange: (filter: MoverFilter) => void;
}) {
  const t = useTranslations('dashboard');
  const options: { value: MoverFilter; label: string; rounded: string }[] = [
    { value: 'all', label: t('topMovers.filter.all'), rounded: 'rounded-l-md border' },
    { value: 'gainers', label: t('topMovers.filter.gainers'), rounded: 'border-t border-b' },
    { value: 'losers', label: t('topMovers.filter.losers'), rounded: 'rounded-r-md border' },
  ];
  return (
    <div className="inline-flex rounded-md shadow-sm">
      {options.map((option) => (
        <button
          key={option.value}
          onClick={() => onChange(option.value)}
          className={`px-3 py-1.5 text-sm font-medium ${option.rounded} ${
            filter === option.value
              ? 'bg-blue-600 text-white border-blue-600'
              : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 border-gray-300 dark:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-600'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function RefreshButton({ onRefresh, isRefreshing, refreshTitle }: { onRefresh?: () => void; isRefreshing?: boolean; refreshTitle: string }) {
  if (!onRefresh) return null;
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onRefresh(); }}
      disabled={isRefreshing}
      className="p-1 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 transition-colors disabled:opacity-50"
      title={refreshTitle}
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

export function TopMovers({ movers, isLoading, hasInvestmentAccounts, onRefresh, isRefreshing }: TopMoversProps) {
  const t = useTranslations('dashboard');
  const router = useRouter();
  const { formatCurrencyPrecise, formatPercent } = useNumberFormat();
  const defaultCurrency = usePreferencesStore((s) => s.preferences?.defaultCurrency) || 'USD';
  const [filter, setFilter] = useState<MoverFilter>(getStoredFilter);

  useEffect(() => {
    try {
      localStorage.setItem(FILTER_STORAGE_KEY, filter);
    } catch {
      // Ignore storage failures (e.g. disabled/blocked storage); persistence is best-effort.
    }
  }, [filter]);

  if (isLoading) {
    return (
      <div className={`${CARD_CLASS} p-3 sm:p-6 lg:min-h-[500px]`}>
        <div className="flex items-center justify-between mb-4">
          <WidgetHeading id="top-movers" onClick={() => router.push('/investments')}>
            {t('topMovers.title')}
          </WidgetHeading>
          <div className="flex items-center gap-2">
            <RefreshButton onRefresh={onRefresh} isRefreshing={isRefreshing} refreshTitle={t('topMovers.refreshPrices')} />
            <span className="text-sm text-gray-500 dark:text-gray-400">{t('topMovers.dailyChange')}</span>
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

  if (movers.length === 0) {
    return (
      <div className={`${CARD_CLASS} p-3 sm:p-6 lg:min-h-[500px]`}>
        <div className="flex items-center justify-between mb-4">
          <WidgetHeading id="top-movers" onClick={() => router.push('/investments')}>
            {t('topMovers.title')}
          </WidgetHeading>
          <RefreshButton onRefresh={onRefresh} isRefreshing={isRefreshing} refreshTitle={t('topMovers.refreshPrices')} />
        </div>
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          {hasInvestmentAccounts
            ? t('topMovers.empty.noPrices')
            : t('topMovers.empty.noInvestments')}
        </p>
      </div>
    );
  }

  // Apply filter, then show top 5. Movers arrive pre-sorted by absolute daily
  // change, so 'all' keeps that order; gainers/losers re-sort directionally.
  const filteredMovers =
    filter === 'gainers'
      ? movers.filter((m) => m.dailyChange > 0).sort((a, b) => b.dailyChangePercent - a.dailyChangePercent)
      : filter === 'losers'
        ? movers.filter((m) => m.dailyChange < 0).sort((a, b) => a.dailyChangePercent - b.dailyChangePercent)
        : movers;
  const topMovers = filteredMovers.slice(0, 5);

  return (
    <div className={`${CARD_CLASS} p-3 sm:p-6 lg:min-h-[500px]`}>
      <div className="flex items-center justify-between mb-4">
        <WidgetHeading id="top-movers" onClick={() => router.push('/investments')}>
          {t('topMovers.title')}
        </WidgetHeading>
        <div className="flex items-center gap-2">
          <RefreshButton onRefresh={onRefresh} isRefreshing={isRefreshing} refreshTitle={t('topMovers.refreshPrices')} />
          <span className="text-sm text-gray-500 dark:text-gray-400">{t('topMovers.dailyChange')}</span>
        </div>
      </div>
      <div className="mb-4">
        <MoverFilterControl filter={filter} onChange={setFilter} />
      </div>
      {topMovers.length === 0 ? (
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          {filter === 'gainers' ? t('topMovers.empty.noGainers') : t('topMovers.empty.noLosers')}
        </p>
      ) : (
      <div className="space-y-2 sm:space-y-3">
        {topMovers.map((mover) => {
          const isPositive = mover.dailyChange >= 0;
          const isForeign = mover.currencyCode && mover.currencyCode !== defaultCurrency;
          const fmtPrice = (value: number) => {
            const formatted = formatCurrencyPrecise(value, mover.currencyCode);
            return isForeign ? `${formatted} ${mover.currencyCode}` : formatted;
          };
          return (
            <button
              key={mover.securityId}
              type="button"
              onClick={() => router.push(`/securities/${mover.securityId}?tab=prices`)}
              title={t('topMovers.openPriceHistory', { symbol: mover.symbol })}
              className="flex w-full items-center justify-between p-2 sm:p-3 rounded-lg border border-gray-200 dark:border-gray-700 text-left transition-colors hover:border-blue-400 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:border-blue-500 dark:hover:bg-gray-700/50"
            >
              <div className="min-w-0">
                {/* The row's content is its accessible name -- symbol, name,
                    price and change -- so the action is added as screen-reader
                    text rather than an aria-label that would replace all of
                    it. */}
                <span className="sr-only">
                  {t('topMovers.openPriceHistory', { symbol: mover.symbol })}
                </span>
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
                  {isPositive ? '+' : ''}{formatCurrencyPrecise(mover.dailyChange, mover.currencyCode)} ({isPositive ? '+' : ''}{formatPercent(mover.dailyChangePercent)})
                </div>
              </div>
            </button>
          );
        })}
      </div>
      )}
      <button
        onClick={() => router.push('/investments')}
        className="mt-3 w-full text-center text-sm text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300"
      >
        {t('topMovers.viewPortfolio')}
      </button>
    </div>
  );
}
