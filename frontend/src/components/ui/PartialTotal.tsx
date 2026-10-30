'use client';

import { useTranslations } from 'next-intl';
import { InfoTooltip } from '@/components/ui/InfoTooltip';
import { isComplete, type ConvertedTotal } from '@/lib/currency-total';

interface PartialTotalProps {
  /** Formatted subtotal, already rendered in the display currency. */
  children: React.ReactNode;
  /** The accumulation the figure came from. */
  total: ConvertedTotal;
  /** Display currency the conversion targeted, for the explanation. */
  displayCurrency: string;
  /** Replaces the missing-rate wording when something else withheld the total. */
  explanation?: string;
}

/**
 * A money figure that is a subtotal, marked as one.
 *
 * When a rate is missing the honest answer is neither the complete-looking total
 * nor silence: it is the part that could be worked out, plus which currencies had
 * to be left out. Rendering it without the marker is what made an Assets card of
 * 20,000 indistinguishable from 120,000 with a 100,000 hole in it.
 *
 * The marker is a visible symbol and a tooltip, not colour alone -- and it names
 * the pairs, because "incomplete" the user cannot act on.
 */
export function PartialTotal({
  children,
  total,
  displayCurrency,
  explanation: explanationOverride,
}: PartialTotalProps) {
  const t = useTranslations('common');

  // A total is a subtotal whenever any component was left out, whether the
  // reason was a missing rate (named currencies) or a value that could not be
  // worked out at all (an unpriced holding, which carries no currency).
  // `isComplete` is the one definition of "nothing excluded".
  if (isComplete(total)) {
    return <>{children}</>;
  }

  // `excludedCount` is every component left out, by any cause; `missingCurrencies`
  // names the subset whose cause was a missing rate. The message keeps the two as
  // independent clauses ("N amounts excluded" then "no rate for these currencies")
  // rather than claiming all N lacked a rate -- a total can mix a missing-rate
  // account with a value-unknown one (a failed brokerage valuation), and only the
  // former has a currency to name. Splitting the count by cause is deliberately
  // not modelled here: the figure and the marker are correct, and a per-cause
  // count would thread two extra numbers through every ConvertedTotal producer for
  // a wording nuance.
  const explanation =
    explanationOverride ??
    (total.missingCurrencies.length > 0
      ? t('partialTotal.explanation', {
          currencies: total.missingCurrencies.join(', '),
          displayCurrency,
          count: total.excludedCount,
        })
      : t('partialTotal.explanationExcluded', { count: total.excludedCount }));

  return (
    <span className="inline-flex items-baseline gap-1" data-testid="partial-total">
      <span>{children}</span>
      <span className="text-amber-600 dark:text-amber-400" aria-hidden="true" data-testid="partial-total-marker">
        *
      </span>
      <span className="sr-only">{t('partialTotal.srSuffix')}</span>
      {/* A money figure sits wherever money is reported: a summary card, a
          group header with `overflow-hidden` on it, the right edge of a
          narrow column. The CSS popover is `absolute` and a fixed 16rem
          wide, so in all three it is clipped by an ancestor or by the
          viewport -- and an explanation the reader cannot finish is the one
          thing this marker exists to give them. `usePortal` is the door
          `InfoTooltip` already has for exactly this: it renders fixed on
          `document.body` and clamps itself to the viewport. */}
      <InfoTooltip placement="top" text={explanation} usePortal />
    </span>
  );
}
