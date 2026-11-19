'use client';

import { useContext } from 'react';
import { useTranslations } from 'next-intl';
import { ChevronLeftIcon, ClockIcon, StarIcon } from '@heroicons/react/24/outline';
import { StarIcon as StarSolidIcon } from '@heroicons/react/24/solid';
import { Button } from '@/components/ui/Button';
import { EntitySwitcher } from '@/components/ui/EntitySwitcher';
import {
  CollapsingTitleContext,
  useCollapsingHeaderTitle,
} from '@/hooks/useCollapsingHeaderTitle';
import { RefreshPricesButton } from '@/components/investments/RefreshPricesButton';
import { useDateFormat } from '@/hooks/useDateFormat';
import { useNumberFormat } from '@/hooks/useNumberFormat';
import { useNow } from '@/hooks/useNow';
import { getMarketState } from '@/lib/market-hours';
import { gainLossColor, withCurrencyCode } from '@/lib/format';
import type { Security } from '@/types/investment';
import { useSecuritySwitcher } from './SecuritySwitcher';

/** The latest quote and how far it moved on the day it was quoted. */
export interface SecurityQuote {
  price: number;
  /** ISO date of the price row the quote comes from. */
  priceDate: string;
  /**
   * ISO instant the quote was struck, when the provider reported one. Null for
   * manual entries and rows stored before the time was kept, which show the
   * date alone rather than a time we would be inventing.
   */
  quotedAt?: string | null;
  /** Change against the previous close; null when there is no earlier price. */
  change: number | null;
  changePercent: number | null;
  /**
   * True when the newest price is recent enough for its move to be "today's".
   * A week-old close still has a delta against the close before it, but calling
   * that today's move would misdate it.
   */
  isCurrent: boolean;
}

interface SecurityDetailHeaderProps {
  security: Security;
  quote: SecurityQuote | null;
  onBack: () => void;
  onEdit: () => void;
  onToggleFavourite: () => void;
  isFavouritePending: boolean;
  /** Re-fetch this security's quote from its price provider. */
  onRefreshPrice: () => void;
  isRefreshingPrice: boolean;
  /** Securities the caret beside the name can jump to; inactive ones are left out. */
  securities: readonly Security[];
}

/**
 * The identity block: which security this is, and what it is worth right now.
 *
 * Deliberately short. Symbol, type, exchange, currency, sector, industry and
 * provider all live in the Key information card a few hundred pixels below, and
 * repeating them here cost a third of the header's height to say the same thing
 * twice. What is left is the name (with a caret to switch securities), the two
 * actions, and the quote.
 */
export function SecurityDetailHeader({
  security,
  quote,
  onBack,
  onEdit,
  onToggleFavourite,
  isFavouritePending,
  onRefreshPrice,
  isRefreshingPrice,
  securities,
}: SecurityDetailHeaderProps) {
  const t = useTranslations('securityDetail');
  const ts = useTranslations('securities');
  const switcher = useSecuritySwitcher(security.id, securities);
  // Below `xl`, once the name scrolls behind the app header, the header reads
  // "Securities - <this security>" and carries the same caret.
  const collapses = useContext(CollapsingTitleContext);
  const titleRef = useCollapsingHeaderTitle<HTMLHeadingElement>(
    collapses ? { title: ts('page.title'), context: security.name, switcher } : null,
  );
  const { formatDate, formatDateTime, formatTimeZoneAbbrev } = useDateFormat();
  const { formatCurrencyPrecise, formatSignedPercent, defaultCurrency } =
    useNumberFormat();
  // The badge below is a statement about the clock, not about the data, so it
  // has to re-read the clock or it goes stale where it sits.
  const now = useNow();

  const FavouriteIcon = security.isFavourite ? StarSolidIcon : StarIcon;
  const favouriteLabel = security.isFavourite
    ? ts('list.favouriteButton.remove')
    : ts('list.favouriteButton.add');

  // Empty when the row carries no instant, or when the instant will not parse;
  // the header then falls back to naming the day, which it always can.
  const quotedAtLabel = quote?.quotedAt ? formatDateTime(quote.quotedAt) : '';
  const zoneAbbrev = formatTimeZoneAbbrev(
    quote?.quotedAt ? new Date(quote.quotedAt) : now,
  );

  const marketState = getMarketState(
    {
      timezone: security.marketTimezone,
      openTime: security.marketOpenTime,
      closeTime: security.marketCloseTime,
    },
    now,
  );
  const marketHoursTitle =
    security.marketOpenTime && security.marketCloseTime && security.marketTimezone
      ? t('header.marketHours', {
          open: security.marketOpenTime.slice(0, 5),
          close: security.marketCloseTime.slice(0, 5),
          zone: security.marketTimezone,
        })
      : undefined;

  return (
    <div className="mb-6">
      <button
        type="button"
        onClick={onBack}
        className="mb-2 -ml-1 inline-flex items-center gap-1 rounded text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
      >
        <ChevronLeftIcon className="h-4 w-4" aria-hidden="true" />
        {t('backToSecurities')}
      </button>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex min-w-0 items-center gap-1">
            {/* While the header is stacked (below `lg`) a long name wraps to as
                many lines as it needs (`break-words`, no clamp) so the whole
                security is readable; on desktop (`lg` and up), where the layout
                flips to a row, the name keeps the single-line ellipsis
                (`lg:truncate`) -- the truncate breakpoint matches the row
                breakpoint so the name only clamps once it shares its line. The
                caret stays beside it either way -- same treatment as the
                mobile-table identity cells. */}
            <h1
              ref={titleRef}
              className="break-words text-2xl font-bold text-gray-900 lg:truncate dark:text-gray-100"
              title={security.name}
            >
              {security.name}
            </h1>
            {/* Jump straight to another security instead of going back to the
                list and picking Details again. */}
            <EntitySwitcher {...switcher} />
          </div>

          {!security.isActive && (
            <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-700 dark:bg-gray-700 dark:text-gray-300">
              {t('header.inactiveBadge')}
            </span>
          )}

          {/* The actions stay inline at every width: there are only a few, and
              an overflow menu whose items jumped the page to a tab further down
              read as the page moving under the user. */}
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={onToggleFavourite}
              isLoading={isFavouritePending}
              aria-pressed={security.isFavourite}
              // The star carries the state visually; the accessible name keeps
              // the wording the securities list already uses for this action.
              aria-label={favouriteLabel}
              title={favouriteLabel}
              className="inline-flex items-center gap-1.5"
            >
              <FavouriteIcon
                className={`h-4 w-4 ${security.isFavourite ? 'text-yellow-500' : ''}`}
                aria-hidden="true"
              />
              {t('header.favourites')}
            </Button>
            <Button variant="outline" size="sm" onClick={onEdit}>
              {t('header.edit')}
            </Button>
            {/* Scoped to this security, so the quote above updates without a
                trip back to Investments to refresh the whole catalog. */}
            <RefreshPricesButton
              size="sm"
              onClick={onRefreshPrice}
              isRefreshing={isRefreshingPrice}
            />
          </div>
        </div>

        {/* The quote: legible, but a step below the name in weight, so the page
            still says what this is before what it costs. */}
        <div className="shrink-0 lg:text-right">
          {quote ? (
            <>
              <div className="flex flex-wrap items-baseline gap-x-3 lg:justify-end">
                <span className="text-2xl font-semibold text-gray-900 dark:text-gray-100">
                  {/* The quote is the largest figure on the page and the one a
                      reader anchors on, so it names its currency too when that
                      is not their own. */}
                  {withCurrencyCode(
                    formatCurrencyPrecise(quote.price, security.currencyCode),
                    security.currencyCode,
                    defaultCurrency,
                  )}
                </span>
                {quote.change !== null && quote.changePercent !== null && (
                  <span
                    className={`text-sm font-medium ${gainLossColor(quote.change)}`}
                  >
                    {t(
                      // A stale quote's delta is still the last move, but it did
                      // not happen today, so it is not labelled as if it had.
                      quote.isCurrent
                        ? 'header.changeToday'
                        : 'header.changeLast',
                      {
                        // Explicitly signed: the colour alone must never be the
                        // only thing telling a gain from a loss.
                        change: `${quote.change >= 0 ? '+' : ''}${formatCurrencyPrecise(
                          quote.change,
                          security.currencyCode,
                        )}`,
                        percent: formatSignedPercent(quote.changePercent),
                      },
                    )}
                  </span>
                )}
              </div>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-gray-500 lg:justify-end dark:text-gray-400">
                <span className="inline-flex items-center gap-1">
                  <ClockIcon className="h-3.5 w-3.5" aria-hidden="true" />
                  {quotedAtLabel
                    ? t('header.priceAtTime', {
                        datetime: quotedAtLabel,
                        zone: zoneAbbrev,
                      })
                    : t('header.priceAt', { date: formatDate(quote.priceDate) })}
                </span>
                {marketState !== 'unknown' && (
                  <span
                    className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-medium ${
                      marketState === 'open'
                        ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300'
                        : 'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300'
                    }`}
                    title={marketHoursTitle}
                  >
                    <span
                      aria-hidden="true"
                      className={`h-1.5 w-1.5 rounded-full ${
                        marketState === 'open' ? 'bg-green-500' : 'bg-gray-400'
                      }`}
                    />
                    {marketState === 'open'
                      ? t('header.marketOpen')
                      : t('header.marketClosed')}
                  </span>
                )}
              </p>
            </>
          ) : (
            <p className="text-sm text-gray-500 dark:text-gray-400">
              {t('header.noPrice')}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
