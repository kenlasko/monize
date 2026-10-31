import type { DensityLevel } from '@/hooks/useTableDensity';

/**
 * Which of the accounts table's columns are drawn at which width, decided once
 * for the header, the group header rows and the account rows.
 *
 * Balance outranks every column to its left: when the table runs short of room
 * it is those columns that go, never Balance scrolling out from behind the
 * sticky Actions column. The tiers are container queries measured on the
 * table's scroll wrapper (`ACCOUNT_TABLE_CONTAINER`), not viewport
 * breakpoints, because the table sits inside page padding and a viewport
 * breakpoint brought columns in before the table could hold them -- the same
 * reason `register-columns.ts` gives for the register.
 *
 * Least important first to go: the two reconciliation columns, then Status,
 * then Type. The Account Name column yields width rather than disappearing
 * (`ACCOUNT_NAME_CELL_FLEX`).
 *
 * The thresholds are measured, not estimated: the tier table rendered with the
 * app's compiled CSS in Chromium, at Normal density with icon actions (the
 * widest the table gets below `ACCOUNT_ACTION_LABELS_MIN_WIDTH`), in en, de, fr
 * and es, with a credit-card row, a combined investment row and a foreign
 * currency figure. The widest locale needed 676px for Type, 776px for Status
 * and 1176px for the reconciliation pair; each tier adds headroom on top for
 * longer names and larger balances. Density does not change which columns
 * exist, so the one set of tiers holds at every density.
 */
export const ACCOUNT_TABLE_CONTAINER = '@container';

export const ACCOUNT_COLUMN_TIER = {
  type: 'hidden @min-[700px]:table-cell',
  status: 'hidden @min-[800px]:table-cell',
  lastReconciled: 'hidden @min-[1200px]:table-cell',
  unreconciled: 'hidden @min-[1200px]:table-cell',
} as const;

/**
 * The name cell's width. Below 480px it keeps its viewport cap; from 480px,
 * where the Actions column appears (`min-[480px]:table-cell`), it is the
 * column that yields -- `w-full` takes whatever the content-sized columns
 * leave and `max-w-0` lets it shrink below its own name (the inner `truncate`
 * ellipsizes it) -- down to a floor that keeps a few characters readable,
 * so a long name can no longer push Balance off the table.
 */
export const ACCOUNT_NAME_CELL_FLEX = 'max-w-[50vw] min-[480px]:w-full min-[480px]:max-w-0 min-[480px]:min-w-28';

/**
 * The narrowest table that holds Normal's text action buttons (Details, Edit,
 * Reconcile, Close, Delete) beside every column: 1376px measured in de, the
 * widest locale. They take ~300px (~400px in German) against ~150px as icons,
 * so below this Normal draws the icon buttons Compact uses, and Balance stays
 * clear of the sticky Actions column. Unlike the tiers this cannot be a
 * container query: it picks which buttons render, not whether a cell shows.
 */
export const ACCOUNT_ACTION_LABELS_MIN_WIDTH = 1400;

/**
 * The density the row actions render at for a table `tableWidth` px wide;
 * `null` (not yet measured, or no ResizeObserver) keeps the chosen density.
 */
export function accountActionDensity(density: DensityLevel, tableWidth: number | null): DensityLevel {
  return density === 'normal' && tableWidth !== null && tableWidth < ACCOUNT_ACTION_LABELS_MIN_WIDTH
    ? 'compact'
    : density;
}
