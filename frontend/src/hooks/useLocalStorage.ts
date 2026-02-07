'use client';

import { useState, useCallback } from 'react';
import { createLogger } from '@/lib/logger';

const logger = createLogger('LocalStorage');

/**
 * Hook that persists state to localStorage
 * Reads synchronously from localStorage on mount to avoid stale-default race conditions
 */
export function useLocalStorage<T>(
  key: string,
  initialValue: T
): [T, (value: T | ((prev: T) => T)) => void] {
  const [storedValue, setStoredValue] = useState<T>(() => {
    if (typeof window === 'undefined') return initialValue;
    try {
      const item = window.localStorage.getItem(key);
      return item !== null ? JSON.parse(item) : initialValue;
    } catch (error) {
      logger.warn(`Error reading localStorage key "${key}":`, error);
      return initialValue;
    }
  });

  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      setStoredValue((prev) => {
        const valueToStore = value instanceof Function ? value(prev) : value;

        // Save to localStorage
        try {
          window.localStorage.setItem(key, JSON.stringify(valueToStore));
        } catch (error) {
          logger.warn(`Error setting localStorage key "${key}":`, error);
        }

        return valueToStore;
      });
    },
    [key]
  );

  return [storedValue, setValue];
}
