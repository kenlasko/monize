'use client';

import { useMemo } from 'react';
import { useFinancialToday } from '@/hooks/useFinancialToday';
import {
  applyPortfolioWindowStart,
  type PortfolioRangeWindow,
} from '@/components/investments/portfolio-range-window';

/**
 * The window a Portfolio Value chart requests: the base window with the
 * per-range portfolio rule applied (`portfolio-range-window.ts`). `start` is
 * the day the series is loaded from, the close the figures are measured from;
 * `periodStart` is where the period the range names opens.
 *
 * One hook for the Portfolio Value report, the Investments chart and the
 * dashboard widget, so the three cannot disagree about where a range opens.
 */
export function usePortfolioRangeWindow(params: {
  range: string;
  /** The window as `useDateRange`/`resolveRangePreset` resolved it. */
  base: { start: string; end: string };
  /** Injectable "now", for deterministic tests. */
  now?: Date;
}): PortfolioRangeWindow {
  const { range, base, now } = params;
  const today = useFinancialToday();
  return useMemo(
    () => applyPortfolioWindowStart(range, base, { now, today }),
    [range, base, now, today],
  );
}
