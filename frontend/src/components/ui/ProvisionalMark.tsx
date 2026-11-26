'use client';

import { useTranslations } from 'next-intl';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { provisionalCountOf } from '@/lib/provisional-amount';

interface ProvisionalMarkProps {
  /** How many provisional amounts the figure beside the mark includes. */
  count: number | null | undefined;
}

/**
 * The mark a headline figure carries while it includes provisional amounts:
 * the importer's estimate of a cross-currency transfer leg, awaiting the other
 * account's own file or the reader's confirmation
 * (`docs/future-plans/provisional-amounts.md` section 9). The figure is never
 * withheld or changed; the mark only says how many estimates are in it and
 * that `is:provisional` lists them. A visible symbol with a tooltip, never a
 * colour alone. Renders nothing at a count of 0 or an absent count.
 *
 * `PartialTotal` draws it through its `provisionalCount` prop, so a figure
 * that is both partial (a missing rate) and provisional carries both marks.
 */
export function ProvisionalMark({ count }: ProvisionalMarkProps) {
  const t = useTranslations('common');
  const n = provisionalCountOf(count);
  if (n === 0) return null;
  return (
    <span className="inline-flex items-baseline" data-testid="provisional-mark">
      <span className="sr-only">{t('provisionalTotal.srSuffix')}</span>
      <InfoTooltip
        placement="top"
        usePortal
        text={t('provisionalTotal.explanation', { count: n })}
        trigger={
          <span
            className="text-gray-500 dark:text-gray-400"
            aria-hidden="true"
            data-testid="provisional-mark-symbol"
          >
            {'≈'}
          </span>
        }
      />
    </span>
  );
}
