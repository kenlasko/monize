import { useMemo } from 'react';

export type DensityLevel = 'normal' | 'compact' | 'dense';

/**
 * How wide a table's cells are inset at a given density.
 *
 * `default` is every table in the app. `wide` is for a register carrying enough
 * columns that the phone inset has to give way before the data does -- it halves
 * the horizontal padding below `sm` and drops one step of vertical padding at
 * `normal`. The investment register and the Folio style's transaction register
 * (two money columns where the others have one) use it.
 *
 * The two exist as named entries rather than as a third and fourth hand-rolled
 * `switch` because that is what they were: three copies of this table lived in
 * three files, agreeing at some levels and silently disagreeing at others, and
 * nothing could tell a deliberate difference from a drifted one.
 */
export type DensityScale = 'default' | 'wide';

const PADDING: Record<DensityScale, Record<DensityLevel, { cell: string; header: string }>> = {
  default: {
    dense: { cell: 'px-3 py-1', header: 'px-3 py-2' },
    compact: { cell: 'px-4 py-2', header: 'px-4 py-2' },
    normal: { cell: 'px-3 sm:px-6 py-4', header: 'px-3 sm:px-6 py-3' },
  },
  wide: {
    dense: { cell: 'px-1.5 sm:px-3 py-1', header: 'px-1.5 sm:px-3 py-2' },
    compact: { cell: 'px-2 sm:px-4 py-2', header: 'px-2 sm:px-4 py-2' },
    normal: { cell: 'px-2 sm:px-6 py-3 sm:py-4', header: 'px-2 sm:px-6 py-2 sm:py-3' },
  },
};

/**
 * Compute memoized cell/header padding classes from a density level.
 *
 * This hook formats; it holds no state. The level itself comes from
 * `useDensityPreference()` (`@/store/densityStore`) -- one app-wide preference,
 * never a local `useState` or a per-view localStorage key. See the store for
 * why, and `density-preference.guard.test.ts` for the scan that enforces both
 * that and the padding living here rather than in a component.
 */
export function useTableDensity(density: DensityLevel, scale: DensityScale = 'default') {
  const cellPadding = useMemo(() => PADDING[scale][density].cell, [density, scale]);
  const headerPadding = useMemo(() => PADDING[scale][density].header, [density, scale]);

  return { cellPadding, headerPadding };
}

/** Cycle through density levels: normal → compact → dense → normal */
export function nextDensity(current: DensityLevel): DensityLevel {
  return current === 'normal' ? 'compact' : current === 'compact' ? 'dense' : 'normal';
}
