'use client';

import { useEffect, useMemo, useState } from 'react';
import { netWorthApi } from '@/lib/net-worth';
import { createLogger } from '@/lib/logger';
import { periodBaselineDate } from '@/components/investments/portfolio-period-result';
import { isPortfolioPeriodPreset } from '@/types/net-worth';
import type { PortfolioTwrSeries, PortfolioTwrSeriesByAccount } from '@/types/net-worth';

const logger = createLogger('useTwrSeries');

interface UseTwrSeriesOptions {
  /** The active range preset ('1d', 'mtd', '1y', ...). */
  range: string;
  /** The day the window is measured from (`usePortfolioRangeWindow`'s `start`). */
  startDate: string;
  /** The day the period opens (`periodStart`). */
  periodStartDate: string;
  endDate: string;
  /**
   * `portfolio` is one series for the scope `accountIds` names; `account` is one
   * series per id in `accountIds`, which it then requires.
   */
  groupBy: 'portfolio' | 'account';
  /** Comma-separated account filter. */
  accountIds?: string;
  /** Report in this currency instead of the reader's preferred one. */
  displayCurrency?: string;
  /** Bumped by the surface when the figures behind the window changed. */
  reloadKey?: number;
  /** Ask nothing yet; see `usePortfolioPeriodResult`'s `skip`. */
  skip?: boolean;
}

export type UseTwrSeriesValue =
  | { status: 'loading'; series: null }
  | { status: 'error'; series: null }
  | { status: 'ready'; groupBy: 'portfolio'; series: PortfolioTwrSeries }
  | { status: 'ready'; groupBy: 'account'; series: PortfolioTwrSeriesByAccount };

type Answer = PortfolioTwrSeries | PortfolioTwrSeriesByAccount | null;

/**
 * The portfolio's time-weighted return, day by day
 * (`docs/specs/portfolio-twr-series.md`).
 *
 * The window is named exactly as `usePortfolioPeriodResult` names it -- a
 * preset as `period`, anything else as its dates with the prior close as
 * `baselineDate` -- so the line and the Return card beside it answer one
 * question and end on one number (INV-PORTTWR-001). The payload is kept with
 * the key of the request that produced it: a range, account or grouping switch
 * never leaves the previous request's line under the new caption, and a failed
 * request is an error, never an empty chart that reads as a flat zero.
 */
export function useTwrSeries({
  range,
  startDate,
  periodStartDate,
  endDate,
  groupBy,
  accountIds,
  displayCurrency,
  reloadKey = 0,
  skip = false,
}: UseTwrSeriesOptions): UseTwrSeriesValue {
  const period = isPortfolioPeriodPreset(range) ? range : undefined;
  const baselineDate = periodBaselineDate(startDate, periodStartDate);
  const key = JSON.stringify([
    groupBy,
    period ?? null,
    periodStartDate,
    endDate,
    baselineDate ?? null,
    accountIds ?? null,
    displayCurrency ?? null,
    reloadKey,
  ]);
  const [state, setState] = useState<{ key: string; answer: Answer } | null>(null);

  // One account per line needs the accounts named: naming none would mean every
  // account, which the server does not accept for this grouping.
  const unaskable = skip || (groupBy === 'account' && !accountIds);

  useEffect(() => {
    // A dated window cannot be asked for before it has a start.
    if (unaskable || (!period && !periodStartDate)) return;
    let cancelled = false;
    const window = period
      ? { period, displayCurrency }
      : { startDate: periodStartDate, endDate, baselineDate, displayCurrency };
    const request: Promise<Answer> =
      groupBy === 'account'
        ? netWorthApi.getInvestmentsTwrSeriesByAccount({
            ...window,
            accountIds: accountIds as string,
          })
        : netWorthApi.getInvestmentsTwrSeries({ ...window, accountIds });
    request
      .then((answer) => {
        if (!cancelled) setState({ key, answer });
      })
      .catch((error) => {
        logger.error('Failed to load the time-weighted return series:', error);
        if (!cancelled) setState({ key, answer: null });
      });
    return () => {
      cancelled = true;
    };
  }, [
    key,
    unaskable,
    period,
    periodStartDate,
    endDate,
    baselineDate,
    groupBy,
    accountIds,
    displayCurrency,
  ]);

  // One object per answer, not per render: the chart memoises its merged rows
  // on this value, and a fresh literal each render would re-merge every point.
  return useMemo((): UseTwrSeriesValue => {
    if (unaskable || state?.key !== key) return { status: 'loading', series: null };
    if (state.answer === null) return { status: 'error', series: null };
    return groupBy === 'account'
      ? {
          status: 'ready',
          groupBy: 'account',
          series: state.answer as PortfolioTwrSeriesByAccount,
        }
      : {
          status: 'ready',
          groupBy: 'portfolio',
          series: state.answer as PortfolioTwrSeries,
        };
  }, [unaskable, state, key, groupBy]);
}
