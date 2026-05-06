'use client';

import { createLogger } from '@/lib/logger';

const logger = createLogger('PortfolioValueChart');

/**
 * Ranges that pull intraday bars from the live quote provider. 1W/1M move
 * from daily-snapshot data to intraday bars when every holding's provider
 * supports it; otherwise the backend signals fallbackToDaily=true and we
 * switch back to the daily endpoint.
 */
export const INTRADAY_RANGES = new Set(['1d', '1w', '1m']);

/**
 * sessionStorage prefix for cached intraday responses. Per-tab, so the data
 * persists during a navigation but not across browser sessions.
 */
export const INTRADAY_CACHE_PREFIX = 'monize-intraday|';

export interface IntradayCachePayload {
  fetchedAt: number;
  points: Array<{ timestamp: string; value: number }>;
  interval: '1m' | '5m' | '15m';
  currency: string;
  fallbackToDaily: boolean;
  skippedSymbols: string[];
}

export function buildIntradayCacheKey(
  range: string,
  accountIds: string[] | undefined,
  currency: string,
): string {
  const accts = (accountIds ?? []).slice().sort().join(',');
  return `${INTRADAY_CACHE_PREFIX}${range}|${accts}|${currency}`;
}

export function readIntradayCache(key: string): IntradayCachePayload | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as IntradayCachePayload;
  } catch {
    return null;
  }
}

export function writeIntradayCache(
  key: string,
  payload: IntradayCachePayload,
): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(key, JSON.stringify(payload));
  } catch (error) {
    logger.warn('Failed to write intraday cache:', error);
  }
}

export function clearAllIntradayCache(): void {
  if (typeof window === 'undefined') return;
  try {
    const ss = window.sessionStorage;
    const keys: string[] = [];
    for (let i = 0; i < ss.length; i++) {
      const k = ss.key(i);
      if (k && k.startsWith(INTRADAY_CACHE_PREFIX)) keys.push(k);
    }
    keys.forEach((k) => ss.removeItem(k));
  } catch (error) {
    logger.warn('Failed to clear intraday cache:', error);
  }
}

/**
 * Round `raw` up to a "nice" axis step (1, 2, 5 × 10^n). Used to pick a
 * y-axis tick interval so labels look clean at any scale.
 */
export function niceAxisStep(raw: number): number {
  if (raw <= 0) return 1;
  const exp = Math.floor(Math.log10(raw));
  const magnitude = Math.pow(10, exp);
  const f = raw / magnitude;
  let nf: number;
  if (f < 1.5) nf = 1;
  else if (f < 3) nf = 2;
  else if (f < 7) nf = 5;
  else nf = 10;
  return nf * magnitude;
}

/**
 * Tight-zoom y-axis bounds. Returns explicit [min, max] (not 'auto') so
 * Recharts doesn't pad the data into the top/bottom slivers of the plot
 * and small price moves stay visible.
 *
 *   - Flat line: ±1% padding (or ±1, whichever is larger).
 *   - Crosses zero: anchor at 0 with nice steps on both sides.
 *   - All-positive / all-negative: 5% padding, snapped to a nice step,
 *     clamped so we don't dive past zero just from padding.
 */
export function computeTightYAxisDomain(
  values: number[],
): [number, number] | [number, 'auto'] {
  if (values.length === 0) return [0, 'auto'];

  const minValue = Math.min(...values);
  const maxValue = Math.max(...values);
  const range = maxValue - minValue;

  if (range === 0) {
    const pad = Math.max(Math.abs(minValue) * 0.01, 1);
    return [minValue - pad, maxValue + pad];
  }

  const crossesZero = minValue < 0 && maxValue > 0;
  if (crossesZero) {
    const niceMaxStep = niceAxisStep((maxValue - 0) / 5);
    const niceMax = Math.ceil(maxValue / niceMaxStep) * niceMaxStep;
    const niceMinStep = niceAxisStep((0 - minValue) / 5);
    const niceMin = Math.floor(minValue / niceMinStep) * niceMinStep;
    return [niceMin, niceMax];
  }

  const padding = range * 0.05;
  const rawMin = minValue - padding;
  const rawMax = maxValue + padding;
  const step = niceAxisStep(range / 5);
  const niceMin = Math.floor(rawMin / step) * step;
  const niceMax = Math.ceil(rawMax / step) * step;

  if (minValue >= 0) {
    return [Math.max(0, niceMin), niceMax];
  }
  return [niceMin, Math.min(0, niceMax)];
}
