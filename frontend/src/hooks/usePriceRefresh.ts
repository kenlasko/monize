'use client';

import { useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { investmentsApi } from '@/lib/investments';
import { createLogger } from '@/lib/logger';
import { getErrorMessage } from '@/lib/errors';

const logger = createLogger('PriceRefresh');
const REFRESH_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

// Module-level state — persists across component mounts within the same SPA session
let lastRefreshTimestamp = 0;
let refreshInProgress = false;

export function isMarketHours(): boolean {
  const now = new Date();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    weekday: 'short',
  }).formatToParts(now);

  const weekday = parts.find((p) => p.type === 'weekday')?.value;
  const hour = parseInt(parts.find((p) => p.type === 'hour')?.value || '0', 10);
  const minute = parseInt(parts.find((p) => p.type === 'minute')?.value || '0', 10);

  if (weekday === 'Sat' || weekday === 'Sun') return false;

  const timeInMinutes = hour * 60 + minute;
  return timeInMinutes >= 570 && timeInMinutes < 960; // 9:30 AM - 4:00 PM
}

export function getRefreshInProgress(): boolean {
  return refreshInProgress;
}

export function setRefreshInProgress(value: boolean): void {
  refreshInProgress = value;
  if (value) {
    lastRefreshTimestamp = Date.now();
  }
}

interface UsePriceRefreshOptions {
  onRefreshComplete?: (lastUpdated?: string) => Promise<void> | void;
}

interface UsePriceRefreshReturn {
  isRefreshing: boolean;
  /**
   * Manually refresh quote prices.
   *
   * @param scopeSecurityIds When provided, only securities whose ID is in
   *   this list are refreshed (intersected with the usual eligibility
   *   filter). The page passes the IDs of the holdings currently shown so
   *   the Refresh button only re-fetches what the user is looking at,
   *   instead of every active security in their catalog.
   */
  triggerManualRefresh: (scopeSecurityIds?: string[]) => Promise<void>;
  triggerAutoRefresh: () => void;
}

export function usePriceRefresh({ onRefreshComplete }: UsePriceRefreshOptions = {}): UsePriceRefreshReturn {
  const [isRefreshing, setIsRefreshing] = useState(false);

  const doRefresh = useCallback(
    async (silent: boolean, scopeSecurityIds?: string[]) => {
      if (refreshInProgress) return;
      refreshInProgress = true;
      setIsRefreshing(true);
      try {
        // Refresh prices for every active security in the user's catalog
        // unless the caller has narrowed the scope (e.g. the Investments
        // page passes the IDs of the holdings currently visible).
        //
        // Eligibility rule mirrors the backend's isRefreshEligible(): a
        // security is eligible when skipPriceUpdates is false OR the user has
        // explicitly opted in by setting a quoteProvider override or an MSN
        // Instrument ID. The latter rescues QIF-imported securities (which are
        // flagged skipPriceUpdates=true by default) once the user has pointed
        // them at a provider.
        const securities = await investmentsApi.getSecurities(false);
        const scopeSet = scopeSecurityIds
          ? new Set(scopeSecurityIds)
          : null;
        const securityIds = securities
          .filter(
            (s) =>
              s.isActive &&
              (!s.skipPriceUpdates || !!s.quoteProvider || !!s.msnInstrumentId) &&
              (scopeSet === null || scopeSet.has(s.id)),
          )
          .map((s) => s.id);
        if (securityIds.length === 0) {
          if (!silent) toast.success('No securities to update');
          return;
        }
        const result = await investmentsApi.refreshSelectedPrices(securityIds);
        lastRefreshTimestamp = Date.now();
        if (!silent) {
          if (result.failed > 0) {
            const failedSymbols = result.results
              .filter((r) => !r.success)
              .map((r) => r.symbol);
            const symbolList = failedSymbols.join(', ');
            toast.error(
              `Prices updated: ${result.updated} succeeded, ${result.failed} failed${symbolList ? ` (${symbolList})` : ''}`,
              { duration: 8000 },
            );
          } else {
            toast.success(`${result.updated} security price${result.updated !== 1 ? 's' : ''} updated`);
          }
        }
        await onRefreshComplete?.(result.lastUpdated);
      } catch (error) {
        logger.error('Failed to refresh prices:', error);
        if (!silent) toast.error(getErrorMessage(error, 'Failed to refresh prices'));
      } finally {
        refreshInProgress = false;
        setIsRefreshing(false);
      }
    },
    [onRefreshComplete],
  );

  const triggerManualRefresh = useCallback(
    async (scopeSecurityIds?: string[]) => {
      await doRefresh(false, scopeSecurityIds);
    },
    [doRefresh],
  );

  const triggerAutoRefresh = useCallback(() => {
    if (!isMarketHours()) {
      logger.info('Skipping auto-refresh: outside market hours');
      return;
    }
    if (Date.now() - lastRefreshTimestamp < REFRESH_COOLDOWN_MS) {
      logger.info('Skipping auto-refresh: cooldown active');
      return;
    }
    if (refreshInProgress) {
      logger.info('Skipping auto-refresh: refresh already in progress');
      return;
    }
    doRefresh(true);
  }, [doRefresh]);

  return { isRefreshing, triggerManualRefresh, triggerAutoRefresh };
}
