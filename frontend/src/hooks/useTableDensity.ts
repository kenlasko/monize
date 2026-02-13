import { useMemo } from 'react';

export type DensityLevel = 'normal' | 'compact' | 'dense';

/**
 * Compute memoized cell/header padding classes from a density level.
 * Density state management is left to the caller (localStorage, props, etc.).
 */
export function useTableDensity(density: DensityLevel) {
  const cellPadding = useMemo(() => {
    switch (density) {
      case 'dense': return 'px-3 py-1';
      case 'compact': return 'px-4 py-2';
      default: return 'px-6 py-4';
    }
  }, [density]);

  const headerPadding = useMemo(() => {
    switch (density) {
      case 'dense': return 'px-3 py-2';
      case 'compact': return 'px-4 py-2';
      default: return 'px-6 py-3';
    }
  }, [density]);

  return { cellPadding, headerPadding };
}

/** Cycle through density levels: normal → compact → dense → normal */
export function nextDensity(current: DensityLevel): DensityLevel {
  return current === 'normal' ? 'compact' : current === 'compact' ? 'dense' : 'normal';
}
