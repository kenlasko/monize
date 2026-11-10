'use client';

import { useReportData } from '@/hooks/useReportData';
import { dashboardTriviaApi } from '@/lib/dashboard-trivia';
import type { DashboardTriviaResponse } from '@/types/dashboard-trivia';

/**
 * The day's trivia, or `null` until it answers. It is decoration: a failed
 * request leaves the column out. Nothing is asked for while `enabled` is false.
 */
export function useDashboardTrivia(enabled: boolean): DashboardTriviaResponse | null {
  const { data } = useReportData(
    () => (enabled ? dashboardTriviaApi.get() : Promise.resolve(null)),
    [enabled],
  );
  return data;
}
