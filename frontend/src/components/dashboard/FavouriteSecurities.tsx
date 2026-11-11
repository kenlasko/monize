'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { FavouriteSecurityQuote } from '@/types/investment';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useDateFormat } from '@/hooks/useDateFormat';
import { UnknownAmount } from '@/components/ui/UnknownAmount';
import { usePreferencesStore } from '@/store/preferencesStore';
import { WidgetHeading } from './widget-meta';
import { CARD_CLASS } from '@/components/ui/Card';
import { preferredCurrency } from '@/lib/default-currency';

interface FavouriteSecuritiesProps {
  securities: FavouriteSecurityQuote[];
  isLoading: boolean;
  onRefresh?: () => void;
  isRefreshing?: boolean;
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

export function FavouriteSecurities({ securities, isLoading, onRefresh, isRefreshing }: FavouriteSecuritiesProps) {
  const t = useTranslations('dashboard');
  const router = useRouter();
  const { formatCurrencyPrecise, formatPercent } = useNumberFormat();
  const { formatDateWithoutYear } = useDateFormat();
  const defaultCurrency = preferredCurrency(
    usePreferencesStore((s) => s.preferences?.defaultCurrency),
  );
  // The session the header is captioned with: the newest one the list has a
  // change for. The server withholds a change whose newest close is no longer
  // current, so this is the day the figures below belong to -- Friday's over a
  // weekend -- and a watchlist with no current change keeps the plain label.
  const latestSession = securities.reduce<string | null>(
    (latest, sec) =>
      sec.priceDate !== null && (latest === null || sec.priceDate > latest)
        ? sec.priceDate
        : latest,
    null,
  );

  if (isLoading) {
    return (
      <div className={`${CARD_CLASS} p-3 sm:p-6`}>
        <div className="flex items-center justify-between mb-4">
          <WidgetHeading id="favourite-securities">
            {t('favouriteSecurities.title')}
          </WidgetHeading>
          <div className="flex items-center gap-2">
            <RefreshButton onRefresh={onRefresh} isRefreshing={isRefreshing} refreshTitle={t('favouriteSecurities.refreshPrices')} />
            <span className="text-sm text-gray-500 dark:text-gray-400">{t('favouriteSecurities.dailyChange')}</span>
          </div>
        </div>
        <div className="animate-pulse skeleton-shimmer space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-12 bg-gray-200 dark:bg-gray-700 rounded" />
          ))}
        </div>
      </div>
    );
  }

  if (securities.length === 0) {
    return (
      <div className={`${CARD_CLASS} p-3 sm:p-6`}>
        <WidgetHeading id="favourite-securities" className="mb-4">
          {t('favouriteSecurities.title')}
        </WidgetHeading>
        <p className="text-gray-500 dark:text-gray-400 text-sm">
          {t.rich('favouriteSecurities.empty', {
            securitiesLink: (chunks) => (
              <button
                onClick={() => router.push('/securities')}
                className="text-blue-600 dark:text-blue-400 hover:underline font-medium"
              >
                {chunks}
              </button>
            ),
          })}
        </p>
      </div>
    );
  }

  return (
    <div className={`${CARD_CLASS} p-3 sm:p-6`}>
      <div className="flex items-center justify-between mb-4">
        <WidgetHeading id="favourite-securities" href="/securities">
          {t('favouriteSecurities.title')}
        </WidgetHeading>
        <div className="flex items-center gap-2">
          <RefreshButton onRefresh={onRefresh} isRefreshing={isRefreshing} refreshTitle={t('favouriteSecurities.refreshPrices')} />
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {latestSession
              ? t('favouriteSecurities.dailyChangeOn', { date: formatDateWithoutYear(latestSession) })
              : t('favouriteSecurities.dailyChange')}
          </span>
        </div>
      </div>
      <div className="space-y-2 sm:space-y-3">
        {securities.map((sec) => {
          // `null` is not a direction: a quote with no current daily move has no
          // sign to colour and no figure to print, which is a different row
          // from one that moved by zero.
          const change = sec.dailyChange;
          const isPositive = change !== null && change >= 0;
          const isForeign = sec.currencyCode && sec.currencyCode !== defaultCurrency;
          const fmtPrice = (value: number) => {
            const formatted = formatCurrencyPrecise(value, sec.currencyCode);
            return isForeign ? `${formatted} ${sec.currencyCode}` : formatted;
          };
          return (
            <button
              key={sec.securityId}
              type="button"
              onClick={() => router.push(`/securities/${sec.securityId}?tab=prices`)}
              title={t('favouriteSecurities.openPriceHistory', { symbol: sec.symbol })}
              className="flex w-full items-center justify-between p-2 sm:p-3 rounded-lg border border-gray-200 dark:border-gray-700 text-left transition-colors hover:border-blue-400 hover:bg-gray-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 dark:hover:border-blue-500 dark:hover:bg-gray-700/50"
            >
              <div className="min-w-0">
                {/* The row's content is its accessible name -- symbol, name,
                    price and change -- so the action is added as screen-reader
                    text rather than an aria-label that would replace all of
                    it. */}
                <span className="sr-only">
                  {t('favouriteSecurities.openPriceHistory', { symbol: sec.symbol })}
                </span>
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
                        change === null
                          ? ''
                          : isPositive
                            ? 'text-green-600 dark:text-green-400'
                            : 'text-red-600 dark:text-red-400'
                      }`}
                    >
                      {change === null || sec.dailyChangePercent === null ? (
                        <UnknownAmount reason="staleQuote" />
                      ) : (
                        <>
                          {isPositive ? '+' : ''}
                          {formatCurrencyPrecise(change, sec.currencyCode)} ({isPositive ? '+' : ''}
                          {formatPercent(sec.dailyChangePercent)})
                        </>
                      )}
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-gray-400 dark:text-gray-500">{t('favouriteSecurities.noPriceYet')}</div>
                )}
                {/* A security whose market closed a session before the others:
                    its change is a real day's move, just not the day the
                    caption above names. */}
                {latestSession && sec.priceDate !== null && sec.priceDate < latestSession && (
                  <div className="text-xs text-gray-500 dark:text-gray-400">
                    {t('widgets.asOf', { date: formatDateWithoutYear(sec.priceDate) })}
                  </div>
                )}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
