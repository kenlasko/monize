'use client';

import { useTranslations } from 'next-intl';
import { PartialTotal } from '@/components/ui/PartialTotal';
import { trendPartialPairs } from '@/lib/budget-trend-completeness';
import type { TrendPointCompleteness } from '@/types/budget';

/** What a partial trend figure leaves out and what to add, or null when whole. */
function usePartialExplanation(points: readonly TrendPointCompleteness[]): string | null {
  const t = useTranslations('reports');
  const tc = useTranslations('common');
  const pairs = trendPartialPairs(points);
  if (pairs === null) return null;
  return pairs.length > 0
    ? t('partialData.weightingNoRate', { pairs: pairs.join(', ') })
    : tc('partialTotal.srSuffix');
}

/**
 * A budget trend figure computed from `points`, marked as a subtotal when any
 * of them is partial: a month whose row had no exchange rate shows only its
 * converted part, and the marker names the pair to add (issue #2155).
 */
export function PartialTrendFigure({
  points,
  children,
}: {
  points: readonly TrendPointCompleteness[];
  children: React.ReactNode;
}) {
  const explanation = usePartialExplanation(points);
  if (explanation === null) return <>{children}</>;
  return (
    <PartialTotal
      total={{ value: 0, missingCurrencies: [], excludedCount: 1 }}
      displayCurrency=""
      explanation={explanation}
    >
      {children}
    </PartialTotal>
  );
}

/**
 * The note under a trend chart whose figures include a partial month: the
 * chart's tooltip marks each such month with `*`, and this says why and what
 * to add. Renders nothing while every point is whole.
 */
export function BudgetTrendPartialNote({
  points,
}: {
  points: readonly TrendPointCompleteness[];
}) {
  const explanation = usePartialExplanation(points);
  if (explanation === null) return null;
  return (
    <p
      className="mt-2 text-xs text-amber-700 dark:text-amber-300"
      data-testid="budget-trend-partial-note"
    >
      <span aria-hidden="true">* </span>
      {explanation}
    </p>
  );
}
