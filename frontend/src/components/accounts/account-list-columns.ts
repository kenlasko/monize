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
 */
export const ACCOUNT_TABLE_CONTAINER = '@container';

export const ACCOUNT_COLUMN_TIER = {
  type: 'hidden @min-[640px]:table-cell',
  status: 'hidden @min-[768px]:table-cell',
  lastReconciled: 'hidden @min-[1120px]:table-cell',
  unreconciled: 'hidden @min-[1120px]:table-cell',
} as const;

/**
 * The name cell's width. On a phone it keeps its viewport cap; from `sm` it is
 * the column that yields -- `w-full` takes whatever the content-sized columns
 * leave and `max-w-0` lets it shrink below its own name (the inner `truncate`
 * ellipsizes it) -- down to a floor that keeps a few characters readable,
 * so a long name can no longer push Balance off the table.
 */
export const ACCOUNT_NAME_CELL_FLEX = 'max-w-[50vw] sm:w-full sm:max-w-0 sm:min-w-28';
