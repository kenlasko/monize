'use client';

import { forwardRef } from 'react';
import { useTranslations } from 'next-intl';
import { Badge, type BadgeVariant } from '@/components/ui/Badge';
import { cn } from '@/lib/utils';
import type { QuickAddChipState, QuickAddTier } from './quick-add-chips';

/**
 * Each tier is told apart by its border as well as its colour, and by a word
 * in the chip's accessible name, never by colour alone. The colours are
 * `Badge`'s own ramps, so the colour themes re-skin them.
 */
const TIER_VARIANT: Record<QuickAddTier, BadgeVariant> = {
  typed: 'blue',
  guessed: 'gray',
  assumed: 'gray',
  needs: 'gray',
};

const TIER_BORDER: Record<QuickAddTier, string> = {
  typed: 'border border-solid border-blue-300 dark:border-blue-700',
  guessed: 'border border-solid border-gray-300 bg-transparent dark:border-gray-500 dark:bg-transparent',
  assumed: 'border border-dashed border-gray-400 bg-transparent dark:border-gray-500 dark:bg-transparent',
  needs: 'border border-solid border-amber-500 bg-transparent dark:border-amber-400 dark:bg-transparent',
};

interface QuickAddChipProps {
  /** The field's name, as the full form labels it ("Account"). */
  fieldLabel: string;
  /** The value as the reader reads it; null when the reading has none. */
  valueText: string | null;
  state: QuickAddChipState;
  expanded: boolean;
  editorId: string;
  /** The reading is being replaced: the chip stays, but does not act. */
  stale: boolean;
  onClick: () => void;
}

/** One field of the reading, as a button that opens the field's control. */
export const QuickAddChip = forwardRef<HTMLButtonElement, QuickAddChipProps>(function QuickAddChip(
  { fieldLabel, valueText, state, expanded, editorId, stale, onClick },
  ref,
) {
  const t = useTranslations('transactions.quickAdd');
  const { tier, need } = state;
  const value = valueText ?? fieldLabel;

  const needText =
    need?.kind === 'missing'
      ? t('need.missing')
      : need?.kind === 'matches'
        ? t('need.matches', { count: need.count })
        : need?.kind === 'new'
          ? t('need.new')
          : null;

  const name =
    need?.kind === 'missing'
      ? t('chipName.missing', { field: fieldLabel })
      : need?.kind === 'matches'
        ? t('chipName.matches', { field: fieldLabel, value, count: need.count })
        : need?.kind === 'new'
          ? t('chipName.new', { field: fieldLabel, value })
          : tier === 'guessed'
            ? t('chipName.guessed', { field: fieldLabel, value })
            : tier === 'assumed'
              ? t('chipName.assumed', { field: fieldLabel, value })
              : t('chipName.typed', { field: fieldLabel, value });

  return (
    <Badge
      as="button"
      ref={ref}
      type="button"
      size="md"
      variant={TIER_VARIANT[tier]}
      data-tier={tier}
      aria-label={name}
      aria-expanded={expanded}
      aria-controls={editorId}
      // Not `disabled`: focus stays on the chip while its reading is replaced.
      aria-disabled={stale || undefined}
      onClick={() => {
        if (!stale) onClick();
      }}
      className={cn(
        'max-w-full cursor-pointer py-1 transition-opacity motion-reduce:transition-none',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-gray-800',
        TIER_BORDER[tier],
        stale && 'cursor-default opacity-60',
      )}
    >
      {tier === 'guessed' && (
        <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
      )}
      <span className="truncate">{value}</span>
      {needText && (
        <Badge variant="amber" size="sm" aria-hidden="true">
          {needText}
        </Badge>
      )}
    </Badge>
  );
});
