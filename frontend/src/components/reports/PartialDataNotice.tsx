'use client';

import { useTranslations } from 'next-intl';

interface PartialDataNoticeProps {
  /** Source currencies with no rate into `displayCurrency`. */
  missingCurrencies: readonly string[];
  /** Rows the server left out of the figures, by any cause. */
  excludedCount: number;
  /** Currency the figures on the report are expressed in. */
  displayCurrency: string;
}

export function partialDataNoticeText(
  t: ReturnType<typeof useTranslations<'reports'>>,
  { missingCurrencies, excludedCount, displayCurrency }: PartialDataNoticeProps,
): string | null {
  if (missingCurrencies.length > 0) {
    return t('partialData.notice', {
      count: excludedCount,
      displayCurrency,
      currencies: missingCurrencies.join(', '),
    });
  }
  return excludedCount ? t('partialData.noticeExcluded', { count: excludedCount }) : null;
}

/**
 * The note a report shows when it has no headline total to mark with
 * `PartialTotal` -- a trend, a breakdown, statistics -- but every figure on it
 * leaves out rows whose currency has no rate. Renders nothing when complete.
 */
export function PartialDataNotice(props: PartialDataNoticeProps) {
  const t = useTranslations('reports');
  const note = partialDataNoticeText(t, props);
  if (!note) return null;

  return (
    <p
      className="text-xs text-amber-600 dark:text-amber-400"
      data-testid="partial-data-notice"
      role="note"
    >
      {note}
    </p>
  );
}
