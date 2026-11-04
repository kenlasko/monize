'use client';

import { useEffect, useState } from 'react';
import { netWorthApi } from '@/lib/net-worth';
import { createLogger } from '@/lib/logger';
import { periodBaselineDate } from '@/components/investments/portfolio-period-result';
import { isPortfolioPeriodPreset } from '@/types/net-worth';
import type { SecurityPeriodResults } from '@/types/net-worth';

const logger = createLogger('useSecurityPeriodResults');

interface UseSecurityPeriodResultsOptions {
  /** The active range preset ('1d', 'mtd', '1y', ...). */
  range: string;
  /** The day the window is measured from (`usePortfolioRangeWindow`'s `start`). */
  startDate: string;
  /** The day the period opens (`periodStart`). */
  periodStartDate: string;
  endDate: string;
  /** Comma-separated account filter. */
  accountIds?: string;
  /** Report in this currency instead of the reader's preferred one. */
  displayCurrency?: string;
  /** Bumped by the surface when the figures behind the window changed. */
  reloadKey?: number;
  /** Ask nothing yet; see `usePortfolioPeriodResult`'s `skip`. */
  skip?: boolean;
}

export interface UseSecurityPeriodResultsValue {
  /** The rows for THIS request; null while loading or after a failure. */
  results: SecurityPeriodResults | null;
  status: 'loading' | 'ready' | 'error';
}

/**
 * Each security's P&L, return and price change over the window
 * (`docs/specs/investment-performance-report-period.md`).
 *
 * The window is named exactly as `usePortfolioPeriodResult` names it -- a
 * preset as `period`, anything else as its dates with the prior close as
 * `baselineDate` -- so the rows and the portfolio figure beside them answer
 * the same window. The payload is kept with the key of the request that
 * produced it: a range or account switch never leaves the previous window's
 * rows under the new window's caption.
 */
export function useSecurityPeriodResults({
  range,
  startDate,
  periodStartDate,
  endDate,
  accountIds,
  displayCurrency,
  reloadKey = 0,
  skip = false,
}: UseSecurityPeriodResultsOptions): UseSecurityPeriodResultsValue {
  const period = isPortfolioPeriodPreset(range) ? range : undefined;
  const baselineDate = periodBaselineDate(startDate, periodStartDate);
  const key = JSON.stringify([
    // The same key `usePortfolioPeriodResult` builds, so the rows and the
    // card beside them are re-asked on the same changes, the day included.
    period ?? null,
    periodStartDate,
    endDate,
    baselineDate ?? null,
    accountIds ?? null,
    displayCurrency ?? null,
    reloadKey,
  ]);
  const [state, setState] = useState<{
    key: string;
    results: SecurityPeriodResults | null;
  } | null>(null);

  useEffect(() => {
    // A dated window cannot be asked for before it has a start.
    if (skip || (!period && !periodStartDate)) return;
    let cancelled = false;
    netWorthApi
      .getInvestmentsSecurityPeriodResults(
        period
          ? { period, accountIds, displayCurrency }
          : {
              startDate: periodStartDate,
              endDate,
              baselineDate,
              accountIds,
              displayCurrency,
            },
      )
      .then((results) => {
        if (!cancelled) setState({ key, results });
      })
      .catch((error) => {
        logger.error('Failed to load the per-security period results:', error);
        // A failed request is unknown, never a window in which nothing moved.
        if (!cancelled) setState({ key, results: null });
      });
    return () => {
      cancelled = true;
    };
  }, [key, skip, period, periodStartDate, endDate, baselineDate, accountIds, displayCurrency]);

  if (state?.key !== key) return { results: null, status: 'loading' };
  return state.results === null
    ? { results: null, status: 'error' }
    : { results: state.results, status: 'ready' };
}
