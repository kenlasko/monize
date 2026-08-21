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
