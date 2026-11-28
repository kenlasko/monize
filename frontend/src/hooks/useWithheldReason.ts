'use client';

import { useFormatter, useTranslations } from 'next-intl';
import { summaryFigureCauses, type SummaryFigure } from '@/lib/portfolio-headline';

/**
 * Why a summary figure the server withheld outright is unknown, in the words of
 * the investments card: the symbols with no price and the pairs with no rate
 * that withhold THIS figure, never the summary's whole list. Falls back to the
 * card's heading when the payload names nothing.
 */
export function useWithheldReason() {
  const t = useTranslations('investments');
  const format = useFormatter();
  return (summary: Parameters<typeof summaryFigureCauses>[0], figure: SummaryFigure): string => {
    const { pairs, unpricedSymbols } = summaryFigureCauses(summary, figure);
    const parts = [
      ...(unpricedSymbols.length > 0
        ? [
            t('portfolioSummary.incompletePrices', {
              symbols: format.list(unpricedSymbols, { type: 'conjunction' }),
            }),
          ]
        : []),
      ...(pairs.length > 0
        ? [
            t('portfolioSummary.incompleteFx', {
              pairs: format.list(pairs, { type: 'conjunction' }),
            }),
          ]
        : []),
    ];
    return parts.length > 0 ? parts.join(' ') : t('portfolioSummary.incompleteHeading');
  };
}
