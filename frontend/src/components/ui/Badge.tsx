import { createElement, type ElementType, type ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The small status pill: a count, a state, a label beside a name.
 *
 * There were roughly fifty hand-rolled copies of this shape in the tree, in
 * six padding combinations and with each colour pair spelled out at the call
 * site, so no two lists agreed on how big a pill was or how strong its tint.
 *
 * The variants stay on Tailwind ramps rather than raw hex so the colour
 * themes can re-skin them; `blue` follows the theme accent, since `themes.css`
 * overrides the blue ramp.
 *
 * This deliberately does NOT replace the pills that carry their own meaning:
 * `CategoryPill` (colour-mix from the category), `AccountTypePill`
 * (`ACCOUNT_TYPE_META`), and the scheduled-kind chips
 * (`SCHEDULED_KIND_CHIP_CLASSES`) are each a single source of truth for what
 * their colour says, and flattening them into a generic variant would throw
 * that away. `ui-conventions.test.ts` exempts them by name.
 */
const BADGE_VARIANTS = {
  gray: 'bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-200',
  blue: 'bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200',
  green: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  red: 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200',
  amber: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  purple: 'bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200',
} as const;

const BADGE_SIZES = {
  sm: 'px-2 py-0.5 text-xs',
  md: 'px-2.5 py-0.5 text-sm',
} as const;

export type BadgeVariant = keyof typeof BADGE_VARIANTS;
export type BadgeSize = keyof typeof BADGE_SIZES;

interface BadgeProps {
  /**
   * Element to render as. A badge that is also a control -- the register's
   * transfer chip is a button -- passes `as="button"` rather than nesting an
   * interactive element inside a span, which the parser would not allow.
   */
  as?: ElementType;
  variant?: BadgeVariant;
  size?: BadgeSize;
  className?: string;
  children?: ReactNode;
  [key: string]: unknown;
}

export function Badge({
  as = 'span',
  variant = 'gray',
  size = 'sm',
  className,
  children,
  ...rest
}: BadgeProps) {
  return createElement(
    as,
    {
      className: cn(
        'inline-flex items-center gap-1 rounded-full font-medium whitespace-nowrap',
        BADGE_VARIANTS[variant],
        BADGE_SIZES[size],
        className,
      ),
      ...rest,
    },
    children,
  );
}
