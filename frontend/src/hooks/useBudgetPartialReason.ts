'use client';

import { useTranslations } from 'next-intl';

/**
 * The sentence that says why a budget figure is unknown: a row had no exchange
 * rate to the budget currency, and which pair. Every budget surface that draws
 * a partial figure as unknown (`UnknownAmount`) takes its text from here.
 */
export function useBudgetPartialReason(): (pairs?: readonly string[]) => string {
  const t = useTranslations('budgets');
  return (pairs) => t('partialSpent.reason', { pairs: (pairs ?? []).join(', ') });
}
