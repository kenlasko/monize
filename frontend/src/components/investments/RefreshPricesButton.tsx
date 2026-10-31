'use client';

import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/Button';
import { RefreshButtonLabel } from '@/components/ui/RefreshButtonLabel';
import { useRelativeTime } from '@/hooks/useRelativeTime';
import { cn } from '@/lib/utils';

interface RefreshPricesButtonProps {
  onClick: () => void;
  isRefreshing: boolean;
  /**
   * ISO timestamp of the last successful price refresh, shown inline and in
   * the tooltip. `null` means the caller tracks it and there has been none;
   * omit it entirely where the age is already on screen (the security detail
   * header carries a "Price at {date}" line under the quote).
   */
  lastPriceUpdate?: string | null;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}

/**
 * The one "refresh quote prices" control. The Investments page, the dashboard
 * and the security detail header all trigger the same `usePriceRefresh` work,
 * so they show the same button rather than three lookalikes that drift apart:
 * the arrow-path icon, a spinner and "Updating..." while in flight, and the
 * age of the last refresh on its own line under the label and in the tooltip.
 *
 * The label and the relative time collapse below `sm` so the icon alone stands
 * in on a phone, where the button sits beside other controls in a header row.
 */
export function RefreshPricesButton({
  onClick,
  isRefreshing,
  lastPriceUpdate,
  size,
  className,
}: RefreshPricesButtonProps) {
  const t = useTranslations('investments');
  const formatRelativeTime = useRelativeTime();

  return (
    <Button
      variant="outline"
      size={size}
      onClick={onClick}
      isLoading={isRefreshing}
      // The age is a second line under the label from `sm` up; the tighter
      // padding keeps the two-line button near the height of its neighbours.
      className={cn('whitespace-nowrap', lastPriceUpdate && !isRefreshing && 'sm:py-1', className)}
      // The label is hidden below `sm`, so name the button for assistive tech
      // rather than leaving the icon to speak for itself.
      aria-label={t('page.refresh')}
      title={
        lastPriceUpdate
          ? t('page.lastUpdated', { time: formatRelativeTime(lastPriceUpdate) })
          : lastPriceUpdate === null
            ? t('page.neverUpdated')
            : t('page.refresh')
      }
    >
      {isRefreshing ? (
        <span className="hidden sm:inline">{t('page.updating')}</span>
      ) : (
        <>
          <svg
            className="h-4 w-4 sm:mr-1.5"
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
            aria-hidden="true"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
            />
          </svg>
          <RefreshButtonLabel
            label={t('page.refresh')}
            updatedAt={lastPriceUpdate}
            className="hidden sm:flex"
          />
        </>
      )}
    </Button>
  );
}
