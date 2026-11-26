'use client';

import { useTranslations } from 'next-intl';
import { provisionalCountOf } from '@/lib/provisional-amount';

interface ProvisionalDataNoticeProps {
  /** How many provisional amounts the figures on the page include. */
  count: number | null | undefined;
  /** Spacing from the caller's layout, applied only when the note renders. */
  className?: string;
}

/**
 * The note a page shows when its figures include provisional amounts and there
 * is no single headline to carry `ProvisionalMark` -- a trend, a table of
 * months, a breakdown. It is the provisional counterpart of
 * `PartialDataNotice`, and the two stand side by side: a figure can be both
 * partial and provisional. Renders nothing at a count of 0 or an absent count
 * (`docs/specs/provisional-amounts.md` section 9).
 */
export function ProvisionalDataNotice({ count, className }: ProvisionalDataNoticeProps) {
  const t = useTranslations('reports');
  const n = provisionalCountOf(count);
  if (n === 0) return null;
  return (
    <p
      className={`text-xs text-gray-500 dark:text-gray-400${className ? ` ${className}` : ''}`}
      data-testid="provisional-data-notice"
      role="note"
    >
      {t('provisionalData.notice', { count: n })}
    </p>
  );
}
