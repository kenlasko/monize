'use client';

import { useReportData } from '@/hooks/useReportData';
import { dashboardTriviaApi } from '@/lib/dashboard-trivia';
import type { DashboardTriviaResponse } from '@/types/dashboard-trivia';

/**
 * The day's trivia, or `null` until it answers. A failed request reads as an
 * empty list: the facts are a nicety, not a figure the reader is waiting on.
 * Nothing is asked for while `enabled` is false.
 */
export function useDashboardTrivia(enabled: boolean): DashboardTriviaResponse | null {
  const { data, error } = useReportData(
    () => (enabled ? dashboardTriviaApi.get() : Promise.resolve(null)),
    [enabled],
  );
  if (error) return { items: [], figures: {}, generatedAt: '' };
  return data;
}
