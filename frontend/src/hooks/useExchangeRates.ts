import { useState, useEffect, useCallback, useMemo } from 'react';
import { exchangeRatesApi, ExchangeRate } from '@/lib/exchange-rates';
import { usePreferencesStore } from '@/store/preferencesStore';
import { createLogger } from '@/lib/logger';

const logger = createLogger('ExchangeRates');

export function useExchangeRates() {
  const [rates, setRates] = useState<ExchangeRate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const defaultCurrency =
    usePreferencesStore((state) => state.preferences?.defaultCurrency) || 'CAD';

  const refresh = useCallback(async () => {
    try {
      const data = await exchangeRatesApi.getLatestRates();
      setRates(data);
    } catch (error) {
      logger.error('Failed to load exchange rates:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Build a lookup map: "USD->CAD" => 1.365
  const rateMap = useMemo(() => {
    const map = new Map<string, number>();
    rates.forEach((r) => {
      map.set(`${r.fromCurrency}->${r.toCurrency}`, Number(r.rate));
    });
    return map;
  }, [rates]);

  const convert = useCallback(
    (amount: number, fromCurrency: string, toCurrency?: string): number => {
      const target = toCurrency || defaultCurrency;
      if (fromCurrency === target) return amount;

      // Direct rate
      const directRate = rateMap.get(`${fromCurrency}->${target}`);
      if (directRate) return amount * directRate;

      // Inverse rate
      const inverseRate = rateMap.get(`${target}->${fromCurrency}`);
      if (inverseRate && inverseRate !== 0) return amount / inverseRate;

      // No rate available, return amount unconverted
      return amount;
    },
    [rateMap, defaultCurrency],
  );

  const convertToDefault = useCallback(
    (amount: number, fromCurrency: string): number => {
      return convert(amount, fromCurrency, defaultCurrency);
    },
    [convert, defaultCurrency],
  );

  const getRate = useCallback(
    (fromCurrency: string, toCurrency?: string): number | null => {
      const target = toCurrency || defaultCurrency;
      if (fromCurrency === target) return 1;
      const direct = rateMap.get(`${fromCurrency}->${target}`);
      if (direct) return direct;
      const inverse = rateMap.get(`${target}->${fromCurrency}`);
      if (inverse && inverse !== 0) return 1 / inverse;
      return null;
    },
    [rateMap, defaultCurrency],
  );

  return {
    rates,
    rateMap,
    isLoading,
    convert,
    convertToDefault,
    getRate,
    refresh,
    defaultCurrency,
  };
}

/**
 * Build a rate map from an array of ExchangeRate objects.
 * Used for historical rate lookups in the NetWorthReport.
 */
export function buildRateMap(rates: ExchangeRate[]): Map<string, number> {
  const map = new Map<string, number>();
  rates.forEach((r) => {
    map.set(`${r.fromCurrency}->${r.toCurrency}`, Number(r.rate));
  });
  return map;
}

/**
 * Convert an amount using a rate map (for historical rate lookups).
 */
export function convertWithRateMap(
  amount: number,
  fromCurrency: string,
  toCurrency: string,
  rateMap: Map<string, number>,
): number {
  if (fromCurrency === toCurrency) return amount;

  const directRate = rateMap.get(`${fromCurrency}->${toCurrency}`);
  if (directRate) return amount * directRate;

  const inverseRate = rateMap.get(`${toCurrency}->${fromCurrency}`);
  if (inverseRate && inverseRate !== 0) return amount / inverseRate;

  return amount;
}
