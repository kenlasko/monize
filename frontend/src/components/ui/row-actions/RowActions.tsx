'use client';

import { useTranslations } from 'next-intl';
import type { DensityLevel } from '@/hooks/useTableDensity';
import { ActionIcon } from './ActionIcon';
import { RowActionsOverflow } from './RowActionsOverflow';
import { TONE_TEXT_CLASS } from './actionTones';
import { visibleActions, type RowAction } from './rowAction';

export interface RowActionsProps {
  actions: RowAction[];
  density: DensityLevel;
  /**
   * When the number of visible actions exceeds this, the surplus folds into a
   * "more" overflow kebab. Defaults to a large number (no folding).
   */
  maxInline?: number;
  /** Extra classes for the flex container. */
  className?: string;
}

/**
 * Standard desktop ACTIONS renderer shared by every list. Renders the contents of
 * the (caller-owned) sticky actions cell:
 * - normal density: colored text-label buttons (preserves the existing look)
 * - compact / dense: icon-only buttons with tooltips (frees horizontal space)
 *
 * Color comes from each action's semantic `tone`, so the same verb looks the same
 * across every list. Callers own the `<td>` (and its striped/selected background);
 * this only renders the buttons.
 */
export function RowActions({ actions, density, maxInline = Infinity, className }: RowActionsProps) {
  const tc = useTranslations('common');
  const shown = visibleActions(actions);
  const iconOnly = density !== 'normal';
  const iconClass = density === 'dense' ? 'w-3.5 h-3.5' : 'w-4 h-4';
  const gap = density === 'dense' ? 'gap-1' : 'gap-2';

  const inline = shown.length > maxInline ? shown.slice(0, maxInline - 1) : shown;
  const overflow = shown.length > maxInline ? shown.slice(maxInline - 1) : [];

  return (
    <div className={`flex justify-end items-center ${gap} ${className ?? ''}`}>
      {inline.map((action) => {
        const tone = TONE_TEXT_CLASS[action.tone];
        const title = action.title ?? action.label;
        if (iconOnly) {
          return (
            <button
              key={action.key}
              type="button"
              onClick={(e) => { e.stopPropagation(); action.onClick(); }}
              disabled={action.disabled}
              title={title}
              aria-label={action.label}
              className={`inline-flex items-center justify-center p-1 rounded ${tone} hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed`}
            >
              <ActionIcon name={action.icon} className={iconClass} />
            </button>
          );
        }
        return (
          <button
            key={action.key}
            type="button"
            onClick={(e) => { e.stopPropagation(); action.onClick(); }}
            disabled={action.disabled}
            title={action.title}
            className={`text-sm font-medium ${tone} disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            {action.label}
          </button>
        );
      })}
      {overflow.length > 0 && (
        <RowActionsOverflow actions={overflow} label={tc('actions.more')} iconClass={iconClass} />
      )}
    </div>
  );
}
