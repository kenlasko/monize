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
  onRefreshComplete?: () => void;
}

interface UsePriceRefreshReturn {
  isRefreshing: boolean;
  triggerManualRefresh: () => Promise<void>;
  triggerAutoRefresh: () => void;
}

export function usePriceRefresh({ onRefreshComplete }: UsePriceRefreshOptions = {}): UsePriceRefreshReturn {
  const [isRefreshing, setIsRefreshing] = useState(false);

  const doRefresh = useCallback(async (silent: boolean) => {
    if (refreshInProgress) return;
    refreshInProgress = true;
    setIsRefreshing(true);
    try {
      const summary = await investmentsApi.getPortfolioSummary();
      const securityIds = [
        ...new Set(
          summary.holdings.filter((h) => h.quantity !== 0).map((h) => h.securityId),
        ),
      ];
      if (securityIds.length === 0) {
        if (!silent) toast.success('No securities to update');
        return;
      }
      const result = await investmentsApi.refreshSelectedPrices(securityIds);
      lastRefreshTimestamp = Date.now();
      if (!silent) {
        if (result.failed > 0) {
          toast.error(`Prices updated: ${result.updated} succeeded, ${result.failed} failed`);
        } else {
          toast.success(`${result.updated} security price${result.updated !== 1 ? 's' : ''} updated`);
        }
      }
      onRefreshComplete?.();
    } catch (error) {
      logger.error('Failed to refresh prices:', error);
      if (!silent) toast.error(getErrorMessage(error, 'Failed to refresh prices'));
    } finally {
      refreshInProgress = false;
      setIsRefreshing(false);
    }
  }, [onRefreshComplete]);

  const triggerManualRefresh = useCallback(async () => {
    await doRefresh(false);
  }, [doRefresh]);

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
