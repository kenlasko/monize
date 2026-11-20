import { createElement, type ReactNode, type ThHTMLAttributes, type TdHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';
import { SortIcon } from './SortIcon';

/**
 * Shared table chrome.
 *
 * These are constants and two thin cells rather than a `<Table>` wrapper on
 * purpose. Eighty-odd tables in this app are hand-laid -- colspans, sticky
 * cells, per-density padding, a body that swaps for a skeleton -- and a
 * component that owned the markup would be fought at every one of them. What
 * actually drifted was the chrome: `divide-y divide-gray-200
 * dark:divide-gray-700` written out 147 times, and the header cell in at
 * least six paddings.
 *
 * `useTableDensity` still owns *row* padding; these are the header and the
 * default body cell, which are not density-dependent.
 */

/** The table element itself: full width, hairline rules between rows. */
export const TABLE_CLASS = 'ui-table min-w-full divide-y divide-gray-200 dark:divide-gray-700';

/** The `<tbody>` rules, where a table divides its body separately. */
export const TABLE_BODY_CLASS = 'divide-y divide-gray-200 dark:divide-gray-700';

/**
 * The header cell for a full-width data table: small, upper-case, muted.
 *
 * `SortableHeader` deliberately does NOT take this. Around twenty-five report
 * tables render it inside a `text-sm` table with a lighter, non-upper-case
 * header, and folding TH_CLASS into it would impose upper-case and `text-xs`
 * on all of them -- a restyle of every report, arriving as a refactor.
 */
export const TH_CLASS =
  'ui-th px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider';

/** The ordinary body cell. */
export const TD_CLASS = 'px-4 py-3 text-sm text-gray-900 dark:text-gray-100';

/** Compact sortable-column control shown above wrapped table rows on phones. */
export const PHONE_HEADER_CLASS =
  'rounded border border-gray-200 bg-white px-2 py-1.5 text-xs font-medium text-gray-500 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-400 uppercase';

/** A wrapped cell's caption is replaced by the real column header from `sm`. */
export const CAPTION_CLASS = 'sm:hidden';

/** Shared structural fields for a sortable data-table column. */
export interface SortColumn<
  Field extends string,
  Alignment extends 'right' | 'center' = 'right' | 'center',
> {
  field: Field;
  label: string;
  align?: Alignment;
}

/** A complete column record whose key must equal the entry's `field`. */
export type SortColumnsByField<Field extends string, Column> = {
  [K in Field]: Column & { field: K };
};

/**
 * The per-cell caption a wide table's value carries on a phone.
 *
 * Below `sm` a wide table wraps each row onto two lines and hides (or replaces)
 * its column header, so every bare figure names its own column here instead of
 * relying on a header the reader can no longer see. One component, so the
 * caption's face cannot drift between tables: two converted tables each grew a
 * local copy before this existed.
 *
 * Pass `className="sm:hidden"` from a table restyled by CSS breakpoints (the
 * real header returns at `sm`); pass nothing from a card branch that only ever
 * renders on phones. Self-describing pills need no caption; numbers and dates do.
 *
 * The caption takes `whitespace-normal` for itself: `white-space` is inherited,
 * and the money cell it sits in is `whitespace-nowrap` so a locale grouping
 * thousands with a space cannot break a number. Inherited onto the caption,
 * that ban stopped a long or unbreakable caption (`[XX-Expenses-XX]` in the
 * pseudo-locale) from wrapping, and it overflowed its track by 20px at 320px,
 * reopening the sideways scroll the wrapped row exists to close. The number
 * keeps the ban; the caption gives it back, here, once, for every table.
 */
export function CellLabel({ children, className }: { children: ReactNode; className?: string }) {
  return createElement(
    'span',
    {
      className: cn(
        'block whitespace-normal text-[10px] font-normal uppercase leading-tight tracking-wide text-gray-400 dark:text-gray-500',
        className,
      ),
    },
    children,
  );
}

type ThProps = ThHTMLAttributes<HTMLTableCellElement> & {
  /** Alignment for this column; `<th>` is centred by default in the UA sheet. */
  align?: 'left' | 'right' | 'center';
  children?: ReactNode;
};

const ALIGN_CLASS = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
} as const;

export function Th({ align = 'left', className, children, ...rest }: ThProps) {
  return createElement(
    'th',
    { className: cn(TH_CLASS, ALIGN_CLASS[align], className), ...rest },
    children,
  );
}

type TdProps = TdHTMLAttributes<HTMLTableCellElement> & {
  align?: 'left' | 'right' | 'center';
  children?: ReactNode;
};

export function Td({ align = 'left', className, children, ...rest }: TdProps) {
  return createElement(
    'td',
    { className: cn(TD_CLASS, ALIGN_CLASS[align], className), ...rest },
    children,
  );
}

type SortableThProps<Field extends string> = Omit<ThHTMLAttributes<HTMLTableCellElement>, 'onClick'> & {
  field: Field;
  sortField: Field;
  sortDirection: 'asc' | 'desc';
  onSort: (field: Field) => void;
  align?: 'left' | 'right' | 'center';
  /** Drawn after the sort button, outside it: an `InfoTooltip` on the column. */
  adornment?: ReactNode;
  children?: ReactNode;
};

/**
 * A list's sortable header cell: a `<th aria-sort>` in `TH_CLASS` holding a
 * `<button>`, so the sort is reached and activated from the keyboard and its
 * direction is announced. A `<th onClick>` is neither. Report tables keep
 * `SortableHeader`, which makes the `<th>` itself focusable.
 */
export function SortableTh<Field extends string>({
  field,
  sortField,
  sortDirection,
  onSort,
  align = 'left',
  adornment,
  className,
  children,
  ...rest
}: SortableThProps<Field>) {
  const active = field === sortField;
  return createElement(
    'th',
    {
      className: cn(TH_CLASS, ALIGN_CLASS[align], className),
      'aria-sort': active ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none',
      ...rest,
    },
    createElement(
      'button',
      {
        type: 'button',
        onClick: () => onSort(field),
        className:
          'inline-flex items-center uppercase tracking-wider rounded hover:text-gray-700 dark:hover:text-gray-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
      },
      children,
      createElement(SortIcon, { field, sortField, sortDirection }),
    ),
    adornment,
  );
}
