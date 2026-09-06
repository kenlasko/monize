import { createElement, type ReactNode, type ThHTMLAttributes, type TdHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

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
export const TABLE_CLASS = 'min-w-full divide-y divide-gray-200 dark:divide-gray-700';

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
  'px-4 py-3 text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider';

/** The ordinary body cell. */
export const TD_CLASS = 'px-4 py-3 text-sm text-gray-900 dark:text-gray-100';

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
