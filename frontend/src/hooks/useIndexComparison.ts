'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { investmentsApi } from '@/lib/investments';
import { createLogger } from '@/lib/logger';
import type { PerformanceComparison } from '@/types/investment';

const logger = createLogger('useIndexComparison');

interface UseIndexComparisonOptions {
  /** Codes of the market indexes to measure; none asks nothing. */
  indexCodes: readonly string[];
  /** The day every index is rebased on, or null while it is not known yet. */
  startDate: string | null;
  endDate: string;
  /** Bumped by the surface when prices were refreshed. */
  reloadKey?: number;
}

export type UseIndexComparisonValue =
  | { status: 'idle'; comparison: null; retry: () => void }
  | { status: 'loading'; comparison: null; retry: () => void }
  | { status: 'error'; comparison: null; retry: () => void }
  | { status: 'ready'; comparison: PerformanceComparison; retry: () => void };

/**
 * Market indexes alone, as cumulative percent return from `startDate`, from
 * the same comparison endpoint the Security Performance report draws them
 * with (`docs/security-benchmark-comparison.md`).
 *
 * The answer is kept with the key of the request that produced it, so a
 * window or index change never leaves the previous answer under the new
 * selection, and a failed request is an error, never an empty overlay. With
 * no index chosen, or no start yet, nothing is asked and nothing renders.
 */
export function useIndexComparison({
  indexCodes,
  startDate,
  endDate,
  reloadKey = 0,
}: UseIndexComparisonOptions): UseIndexComparisonValue {
  const [attempt, setAttempt] = useState(0);
  const codes = [...indexCodes].sort().join(',');
  const idle = codes === '' || startDate === null;
  const key = JSON.stringify([codes, startDate, endDate, reloadKey, attempt]);
  const [state, setState] = useState<{
    key: string;
    answer: PerformanceComparison | null;
  } | null>(null);

  useEffect(() => {
    if (idle) return;
    let cancelled = false;
    investmentsApi
      .getPerformanceComparison({
        indexCodes: codes.split(','),
        startDate: startDate ?? undefined,
        endDate: endDate || undefined,
      })
      .then((answer) => {
        if (!cancelled) setState({ key, answer });
      })
      .catch((error) => {
        logger.error('Failed to load the market index comparison:', error);
        if (!cancelled) setState({ key, answer: null });
      });
    return () => {
      cancelled = true;
    };
  }, [idle, key, codes, startDate, endDate]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  return useMemo((): UseIndexComparisonValue => {
    if (idle) return { status: 'idle', comparison: null, retry };
    if (state?.key !== key) return { status: 'loading', comparison: null, retry };
    if (state.answer === null) return { status: 'error', comparison: null, retry };
    return { status: 'ready', comparison: state.answer, retry };
  }, [idle, state, key, retry]);
}
